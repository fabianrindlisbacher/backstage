/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { Entity } from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import { assertError, ForwardedError } from '@backstage/errors';
import {
  AwsCredentialsManager,
  DefaultAwsCredentialsManager,
} from '@backstage/integration-aws-node';
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { HttpsProxyAgent } from 'hpagent';
import { Response } from 'express';
import JSON5 from 'json5';
import path from 'path';
import { Readable } from 'stream';
import { Logger } from 'winston';
import {
  getHeadersForFileExtension,
  lowerCaseEntityTriplet,
  lowerCaseEntityTripletInStoragePath,
  normalizeExternalStorageRootPath,
} from './helpers';
import { ReaderBase, ReadinessResponse, TechDocsMetadata } from './types';
import { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';

const streamToBuffer = (stream: Readable): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    try {
      const chunks: any[] = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', (e: Error) =>
        reject(new ForwardedError('Unable to read stream', e)),
      );
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    } catch (e) {
      throw new ForwardedError('Unable to parse the response data', e);
    }
  });
};

const TECHDOCS_S3_BUCKET_ANNOTATION = 'backstage.io/techdocs-awsS3-bucket';

export class AwsS3Read implements ReaderBase {
  private readonly storageClient: S3Client;
  private readonly bucketName: string;
  private readonly legacyPathCasing: boolean;
  private readonly logger: Logger;
  private readonly bucketRootPath: string;
  private readonly sse?: 'aws:kms' | 'AES256';

  constructor(options: {
    storageClient: S3Client;
    bucketName: string;
    legacyPathCasing: boolean;
    logger: Logger;
    bucketRootPath: string;
    sse?: 'aws:kms' | 'AES256';
  }) {
    this.storageClient = options.storageClient;
    this.bucketName = options.bucketName;
    this.legacyPathCasing = options.legacyPathCasing;
    this.logger = options.logger;
    this.bucketRootPath = options.bucketRootPath;
    this.sse = options.sse;
  }

  static async fromConfig(config: Config, logger: Logger): Promise<ReaderBase> {
    let bucketName = '';
    try {
      bucketName = config.getString('techdocs.reader.awsS3.bucketName');
    } catch (error) {
      throw new Error(
        "Since techdocs.reader.type is set to 'awsS3' in your app config, " +
          'techdocs.reader.awsS3.bucketName is required.',
      );
    }

    const bucketRootPath = normalizeExternalStorageRootPath(
      config.getOptionalString('techdocs.reader.awsS3.bucketRootPath') || '',
    );

    const sse = config.getOptionalString('techdocs.reader.awsS3.sse') as
      | 'aws:kms'
      | 'AES256'
      | undefined;

    // AWS Region is an optional config. If missing, default AWS env variable AWS_REGION
    // or AWS shared credentials file at ~/.aws/credentials will be used.
    const region = config.getOptionalString('techdocs.reader.awsS3.region');

    // Credentials can optionally be configured by specifying the AWS account ID, which will retrieve credentials
    // for the account from the 'aws' section of the app config.
    // Credentials can also optionally be directly configured in the techdocs awsS3 config, but this method is
    // deprecated.
    // If no credentials are configured, the AWS SDK V3's default credential chain will be used.
    const accountId = config.getOptionalString(
      'techdocs.reader.awsS3.accountId',
    );
    const credentialsConfig = config.getOptionalConfig(
      'techdocs.reader.awsS3.credentials',
    );
    const credsManager = DefaultAwsCredentialsManager.fromConfig(config);
    const sdkCredentialProvider = await AwsS3Read.buildCredentials(
      credsManager,
      accountId,
      credentialsConfig,
      region,
    );

    // AWS endpoint is an optional config. If missing, the default endpoint is built from
    // the configured region.
    const endpoint = config.getOptionalString('techdocs.reader.awsS3.endpoint');

    // AWS HTTPS proxy is an optional config. If missing, no proxy is used
    const httpsProxy = config.getOptionalString(
      'techdocs.reader.awsS3.httpsProxy',
    );

    // AWS forcePathStyle is an optional config. If missing, it defaults to false. Needs to be enabled for cases
    // where endpoint url points to locally hosted S3 compatible storage like Localstack
    const forcePathStyle = config.getOptionalBoolean(
      'techdocs.reader.awsS3.s3ForcePathStyle',
    );

    const storageClient = new S3Client({
      customUserAgent: 'backstage-aws-techdocs-s3-publisher',
      credentialDefaultProvider: () => sdkCredentialProvider,
      ...(region && { region }),
      ...(endpoint && { endpoint }),
      ...(forcePathStyle && { forcePathStyle }),
      ...(httpsProxy && {
        requestHandler: new NodeHttpHandler({
          httpsAgent: new HttpsProxyAgent({ proxy: httpsProxy }),
        }),
      }),
    });

    const legacyPathCasing =
      config.getOptionalBoolean(
        'techdocs.legacyUseCaseSensitiveTripletPaths',
      ) || false;

    return new AwsS3Read({
      storageClient,
      bucketName,
      bucketRootPath,
      legacyPathCasing,
      logger,
      sse,
    });
  }

  /**
   * Check if the defined bucket exists. Being able to connect means the configuration is good
   * and the storage client will work.
   */
  async getReadiness(): Promise<ReadinessResponse> {
    try {
      await this.storageClient.send(
        new HeadBucketCommand({ Bucket: this.bucketName }),
      );

      this.logger.info(
        `Successfully connected to the AWS S3 bucket ${this.bucketName}.`,
      );

      return { isAvailable: true };
    } catch (error) {
      this.logger.error(
        `Could not retrieve metadata about the AWS S3 bucket ${this.bucketName}. ` +
          'Make sure the bucket exists. Also make sure that authentication is setup either by ' +
          'explicitly defining credentials and region in techdocs.reader.awsS3 in app config or ' +
          'by using environment variables. Refer to https://backstage.io/docs/features/techdocs/using-cloud-storage',
      );
      this.logger.error(`from AWS client library`, error);
      return {
        isAvailable: false,
      };
    }
  }

  async fetchTechDocsMetadata(entity: Entity): Promise<TechDocsMetadata> {
    try {
      return await new Promise<TechDocsMetadata>(async (resolve, reject) => {
        const entityTriplet = `${entity.metadata.namespace}/${entity.kind}/${entity.metadata.name}`;
        const entityDir = this.legacyPathCasing
          ? entityTriplet
          : lowerCaseEntityTriplet(entityTriplet);

        const entityRootDir = path.posix.join(this.bucketRootPath, entityDir);

        try {
          const bucket = entity?.metadata?.annotations?.[
            TECHDOCS_S3_BUCKET_ANNOTATION
          ]
            ? entity.metadata?.annotations?.[TECHDOCS_S3_BUCKET_ANNOTATION]
            : this.bucketName;
          const resp = await this.storageClient.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: `${entityRootDir}/techdocs_metadata.json`,
            }),
          );

          const techdocsMetadataJson = await streamToBuffer(
            resp.Body as Readable,
          );
          if (!techdocsMetadataJson) {
            throw new Error(
              `Unable to parse the techdocs metadata file ${entityRootDir}/techdocs_metadata.json.`,
            );
          }

          const techdocsMetadata = JSON5.parse(
            techdocsMetadataJson.toString('utf-8'),
          );

          resolve(techdocsMetadata);
        } catch (err) {
          assertError(err);
          this.logger.error(err.message);
          reject(new Error(err.message));
        }
      });
    } catch (e) {
      throw new ForwardedError('TechDocs metadata fetch failed', e);
    }
  }

  /**
   * Express route middleware to serve static files on a route in techdocs-backend.
   */
  async proxyDocs(decodedUri: string, res: Response, entity?: Entity) {
    // filePath example - /default/component/documented-component/index.html
    const filePathNoRoot = this.legacyPathCasing
      ? decodedUri
      : lowerCaseEntityTripletInStoragePath(decodedUri);

    // Prepend the root path to the relative file path
    const filePath = path.posix.join(this.bucketRootPath, filePathNoRoot);

    // Files with different extensions (CSS, HTML) need to be served with different headers
    const fileExtension = path.extname(filePath);
    const responseHeaders = getHeadersForFileExtension(fileExtension);

    try {
      const bucket = entity?.metadata?.annotations?.[
        TECHDOCS_S3_BUCKET_ANNOTATION
      ]
        ? entity.metadata?.annotations?.[TECHDOCS_S3_BUCKET_ANNOTATION]
        : this.bucketName;

      const resp = await this.storageClient.send(
        new GetObjectCommand({ Bucket: bucket, Key: filePath }),
      );

      // Inject response headers
      for (const [headerKey, headerValue] of Object.entries(responseHeaders)) {
        res.setHeader(headerKey, headerValue);
      }

      res.send(await streamToBuffer(resp.Body as Readable));
    } catch (err) {
      assertError(err);
      this.logger.warn(
        `TechDocs S3 router failed to serve static files from bucket ${this.bucketName} at key ${filePath}: ${err.message}`,
      );
      res.status(404).send('File Not Found');
    }
  }

  /**
   * A helper function which checks if index.html of an Entity's docs site is available. This
   * can be used to verify if there are any pre-generated docs available to serve.
   */
  async hasDocsBeenGenerated(entity: Entity): Promise<boolean> {
    try {
      const entityTriplet = `${entity.metadata.namespace}/${entity.kind}/${entity.metadata.name}`;
      const entityDir = this.legacyPathCasing
        ? entityTriplet
        : lowerCaseEntityTriplet(entityTriplet);

      const entityRootDir = path.posix.join(this.bucketRootPath, entityDir);

      await this.storageClient.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: `${entityRootDir}/index.html`,
        }),
      );
      return Promise.resolve(true);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  private static async buildCredentials(
    credsManager: AwsCredentialsManager,
    accountId?: string,
    config?: Config,
    region?: string,
  ): Promise<AwsCredentialIdentityProvider> {
    // Pull credentials for the specified account ID from the 'aws' config section
    if (accountId) {
      return (await credsManager.getCredentialProvider({ accountId }))
        .sdkCredentialProvider;
    }

    // Fall back to the default credential chain if neither account ID
    // nor explicit credentials are provided
    if (!config) {
      return (await credsManager.getCredentialProvider()).sdkCredentialProvider;
    }

    // Pull credentials from the techdocs config section (deprecated)
    const accessKeyId = config.getOptionalString('accessKeyId');
    const secretAccessKey = config.getOptionalString('secretAccessKey');
    const explicitCredentials: AwsCredentialIdentityProvider =
      accessKeyId && secretAccessKey
        ? AwsS3Read.buildStaticCredentials(accessKeyId, secretAccessKey)
        : (await credsManager.getCredentialProvider()).sdkCredentialProvider;

    const roleArn = config.getOptionalString('roleArn');
    if (roleArn) {
      return fromTemporaryCredentials({
        masterCredentials: explicitCredentials,
        params: {
          RoleSessionName: 'backstage-aws-techdocs-s3-publisher',
          RoleArn: roleArn,
        },
        clientConfig: { region },
      });
    }

    return explicitCredentials;
  }

  private static buildStaticCredentials(
    accessKeyId: string,
    secretAccessKey: string,
  ): AwsCredentialIdentityProvider {
    return async () => {
      return Promise.resolve({
        accessKeyId,
        secretAccessKey,
      });
    };
  }
}

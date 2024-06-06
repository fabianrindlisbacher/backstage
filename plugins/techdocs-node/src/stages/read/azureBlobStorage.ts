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
import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { CompoundEntityRef, Entity } from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import { assertError, ForwardedError } from '@backstage/errors';
import express, { Response } from 'express';
import JSON5 from 'json5';
import { default as platformPath } from 'path';
import { Logger } from 'winston';
import {
  getHeadersForFileExtension,
  lowerCaseEntityTriplet,
  lowerCaseEntityTripletInStoragePath,
} from './helpers';
import { ReaderBase, ReadinessResponse, TechDocsMetadata } from './types';

export class AzureBlobStorageRead implements ReaderBase {
  private readonly storageClient: BlobServiceClient;
  private readonly containerName: string;
  private readonly legacyPathCasing: boolean;
  private readonly logger: Logger;

  constructor(options: {
    storageClient: BlobServiceClient;
    containerName: string;
    legacyPathCasing: boolean;
    logger: Logger;
  }) {
    this.storageClient = options.storageClient;
    this.containerName = options.containerName;
    this.legacyPathCasing = options.legacyPathCasing;
    this.logger = options.logger;
  }

  static fromConfig(config: Config, logger: Logger): ReaderBase {
    let storageClient: BlobServiceClient;
    let containerName = '';
    try {
      containerName = config.getString(
        'techdocs.reader.azureBlobStorage.containerName',
      );
    } catch (error) {
      throw new Error(
        "Since techdocs.reader.type is set to 'azureBlobStorage' in your app config, " +
          'techdocs.reader.azureBlobStorage.containerName is required.',
      );
    }

    const legacyPathCasing =
      config.getOptionalBoolean(
        'techdocs.legacyUseCaseSensitiveTripletPaths',
      ) || false;

    // Give more priority for connectionString, if configured, return the AzureBlobStorageRead object here itself
    const connectionStringKey =
      'techdocs.reader.azureBlobStorage.connectionString';
    const connectionString = config.getOptionalString(connectionStringKey);

    if (connectionString) {
      logger.info(
        `Using '${connectionStringKey}' configuration to create storage client`,
      );
      storageClient = BlobServiceClient.fromConnectionString(connectionString);
    } else {
      let accountName = '';
      try {
        accountName = config.getString(
          'techdocs.reader.azureBlobStorage.credentials.accountName',
        );
      } catch (error) {
        throw new Error(
          "Since techdocs.reader.type is set to 'azureBlobStorage' in your app config, " +
            'techdocs.reader.azureBlobStorage.credentials.accountName is required.',
        );
      }

      // Credentials is an optional config. If missing, default Azure Blob Storage environment variables will be used.
      // https://docs.microsoft.com/en-us/azure/storage/common/storage-auth-aad-app
      const accountKey = config.getOptionalString(
        'techdocs.reader.azureBlobStorage.credentials.accountKey',
      );

      let credential;
      if (accountKey) {
        credential = new StorageSharedKeyCredential(accountName, accountKey);
      } else {
        credential = new DefaultAzureCredential();
      }

      storageClient = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        credential,
      );
    }

    return new AzureBlobStorageRead({
      storageClient: storageClient,
      containerName: containerName,
      legacyPathCasing: legacyPathCasing,
      logger: logger,
    });
  }

  async getReadiness(): Promise<ReadinessResponse> {
    try {
      const response = await this.storageClient
        .getContainerClient(this.containerName)
        .getProperties();

      if (response._response.status === 200) {
        return {
          isAvailable: true,
        };
      }

      if (response._response.status >= 400) {
        this.logger.error(
          `Failed to retrieve metadata from ${response._response.request.url} with status code ${response._response.status}.`,
        );
      }
    } catch (e) {
      assertError(e);
      this.logger.error(`from Azure Blob Storage client library: ${e.message}`);
    }

    this.logger.error(
      `Could not retrieve metadata about the Azure Blob Storage container ${this.containerName}. ` +
        'Make sure that the Azure project and container exist and the access key is setup correctly ' +
        'techdocs.reader.azureBlobStorage.credentials defined in app config has correct permissions. ' +
        'Refer to https://backstage.io/docs/features/techdocs/using-cloud-storage',
    );

    return { isAvailable: false };
  }

  private download(containerName: string, blobPath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const fileStreamChunks: Array<any> = [];
      this.storageClient
        .getContainerClient(containerName)
        .getBlockBlobClient(blobPath)
        .download()
        .then(res => {
          const body = res.readableStreamBody;
          if (!body) {
            reject(new Error(`Unable to parse the response data`));
            return;
          }
          body
            .on('error', reject)
            .on('data', chunk => {
              fileStreamChunks.push(chunk);
            })
            .on('end', () => {
              resolve(Buffer.concat(fileStreamChunks));
            });
        })
        .catch(reject);
    });
  }

  async fetchTechDocsMetadata(entity: Entity): Promise<TechDocsMetadata> {
    const entityTriplet = `${entity.metadata.namespace}/${entity.kind}/${entity.metadata.name}`;
    const entityRootDir = this.legacyPathCasing
      ? entityTriplet
      : lowerCaseEntityTriplet(entityTriplet);

    try {
      const techdocsMetadataJson = await this.download(
        this.containerName,
        `${entityRootDir}/techdocs_metadata.json`,
      );
      if (!techdocsMetadataJson) {
        throw new Error(
          `Unable to parse the techdocs metadata file ${entityRootDir}/techdocs_metadata.json.`,
        );
      }
      const techdocsMetadata = JSON5.parse(
        techdocsMetadataJson.toString('utf-8'),
      );
      return techdocsMetadata;
    } catch (e) {
      throw new ForwardedError('TechDocs metadata fetch failed', e);
    }
  }

  /**
   * Express route middleware to serve static files on a route in techdocs-backend.
   */
  proxyDocs(decodedUri: string, res: Response, entity?: Entity) {
    // filePath example - /default/Component/documented-component/index.html
    const filePath = this.legacyPathCasing
      ? decodedUri
      : lowerCaseEntityTripletInStoragePath(decodedUri);

    // Files with different extensions (CSS, HTML) need to be served with different headers
    const fileExtension = platformPath.extname(filePath);
    const responseHeaders = getHeadersForFileExtension(fileExtension);

    this.download(this.containerName, filePath)
      .then(fileContent => {
        // Inject response headers
        for (const [headerKey, headerValue] of Object.entries(
          responseHeaders,
        )) {
          res.setHeader(headerKey, headerValue);
        }
        res.send(fileContent);
      })
      .catch(e => {
        this.logger.warn(
          `TechDocs Azure router failed to serve content from container ${this.containerName} at path ${filePath}: ${e.message}`,
        );
        res.status(404).send('File Not Found');
      });
  }

  protected async renameBlob(
    originalName: string,
    newName: string,
    removeOriginal = false,
  ): Promise<void> {
    const container = this.storageClient.getContainerClient(this.containerName);
    const blob = container.getBlobClient(newName);
    const { url } = container.getBlobClient(originalName);
    const response = await blob.beginCopyFromURL(url);
    await response.pollUntilDone();
    if (removeOriginal) {
      await container.deleteBlob(originalName);
    }
  }

  protected async renameBlobToLowerCase(
    originalPath: string,
    removeOriginal: boolean,
  ) {
    let newPath;
    try {
      newPath = lowerCaseEntityTripletInStoragePath(originalPath);
    } catch (e) {
      assertError(e);
      this.logger.warn(e.message);
      return;
    }

    if (originalPath === newPath) return;
    try {
      this.logger.verbose(`Migrating ${originalPath}`);
      await this.renameBlob(originalPath, newPath, removeOriginal);
    } catch (e) {
      assertError(e);
      this.logger.warn(`Unable to migrate ${originalPath}: ${e.message}`);
    }
  }

  protected async getAllBlobsFromContainer({
    prefix,
    maxPageSize,
  }: {
    prefix: string;
    maxPageSize: number;
  }): Promise<string[]> {
    const blobs: string[] = [];
    const container = this.storageClient.getContainerClient(this.containerName);

    let iterator = container.listBlobsFlat({ prefix }).byPage({ maxPageSize });
    let response = (await iterator.next()).value;

    do {
      for (const blob of response?.segment?.blobItems ?? []) {
        blobs.push(blob.name);
      }
      iterator = container
        .listBlobsFlat({ prefix })
        .byPage({ continuationToken: response.continuationToken, maxPageSize });
      response = (await iterator.next()).value;
    } while (response && response.continuationToken);

    return blobs;
  }
}

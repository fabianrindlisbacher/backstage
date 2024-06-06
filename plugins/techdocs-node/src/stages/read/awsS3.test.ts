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

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Entity, DEFAULT_NAMESPACE } from '@backstage/catalog-model';
import { ConfigReader } from '@backstage/config';
import {
  AwsCredentialProvider,
  AwsCredentialProviderOptions,
  DefaultAwsCredentialsManager,
} from '@backstage/integration-aws-node';
import { mockClient, AwsClientStub } from 'aws-sdk-client-mock';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs-extra';
import { AwsS3Read } from './awsS3';
import { Readable } from 'stream';
import {
  createMockDirectory,
  mockServices,
} from '@backstage/backend-test-utils';
import { loggerToWinstonLogger } from '@backstage/backend-common';

const env = process.env;
let s3Mock: AwsClientStub<S3Client>;

const mockDir = createMockDirectory();

function getMockCredentialProvider(): Promise<AwsCredentialProvider> {
  return Promise.resolve({
    sdkCredentialProvider: async () => {
      return Promise.resolve({
        accessKeyId: 'MY_ACCESS_KEY_ID',
        secretAccessKey: 'MY_SECRET_ACCESS_KEY',
      });
    },
  });
}

const getCredProviderMock = jest.spyOn(
  DefaultAwsCredentialsManager.prototype,
  'getCredentialProvider',
);

const getEntityRootDir = (entity: Entity, entityRootPath: string) => {
  const {
    kind,
    metadata: { namespace, name },
  } = entity;

  return mockDir.resolve(
    entityRootPath || '',
    namespace || DEFAULT_NAMESPACE,
    kind,
    name,
  );
};

class ErrorReadable extends Readable {
  errorMessage: string;

  constructor(errorMessage: string) {
    super();
    this.errorMessage = errorMessage;
  }

  _read() {
    this.destroy(new Error(this.errorMessage));
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    callback(error);
  }
}

const logger = loggerToWinstonLogger(mockServices.logger.mock());
const loggerInfoSpy = jest.spyOn(logger, 'info');
const loggerErrorSpy = jest.spyOn(logger, 'error');

const createReaderFromConfig = async ({
  bucketName = 'bucketName',
  bucketRootPath = '/',
  legacyUseCaseSensitiveTripletPaths = false,
  sse,
}: {
  bucketName?: string;
  bucketRootPath?: string;
  legacyUseCaseSensitiveTripletPaths?: boolean;
  sse?: string;
} = {}) => {
  const mockConfig = new ConfigReader({
    techdocs: {
      reader: {
        type: 'awsS3',
        awsS3: {
          accountId: '111111111111',
          bucketName,
          bucketRootPath,
          sse,
        },
      },
      legacyUseCaseSensitiveTripletPaths,
    },
    aws: {
      accounts: [
        {
          accountId: '111111111111',
          accessKeyId: 'my-access-key',
          secretAccessKey: 'my-secret-access-key',
        },
      ],
    },
  });

  return await AwsS3Read.fromConfig(mockConfig, logger);
};

describe('AwsS3Read', () => {
  const entity = {
    apiVersion: '1',
    kind: 'component',
    metadata: {
      name: 'backstage',
      namespace: 'default',
      annotations: {},
    },
  };

  const invalidEntity = {
    apiVersion: '1',
    kind: 'triplet',
    metadata: {
      name: 'path',
      namespace: 'invalid',
      annotations: {},
    },
  };

  const techdocsMetadata = {
    site_name: 'backstage',
    site_description: 'site_content',
    etag: 'etag',
    build_timestamp: 612741599,
  };

  const directory = getEntityRootDir(entity);

  const files = {
    'index.html': '',
    '404.html': '',
    'techdocs_metadata.json': JSON.stringify(techdocsMetadata),
    assets: {
      'main.css': '',
    },
    html: {
      'unsafe.html': '<html></html>',
    },
    img: {
      'with spaces.png': 'found it',
      'unsafe.svg': '<svg></svg>',
    },
    'some folder': {
      'also with spaces.js': 'found it too',
    },
  };

  beforeEach(() => {
    process.env = { ...env };
    process.env.AWS_REGION = 'us-west-2';

    jest.resetAllMocks();
    getCredProviderMock.mockImplementation((_?: AwsCredentialProviderOptions) =>
      getMockCredentialProvider(),
    );

    mockDir.setContent({
      [directory]: files,
    });

    s3Mock = mockClient(S3Client);

    s3Mock.on(HeadObjectCommand).callsFake(input => {
      if (!fs.pathExistsSync(mockDir.resolve(input.Key))) {
        throw new Error('File does not exist');
      }
      return {};
    });

    s3Mock.on(GetObjectCommand).callsFake(input => {
      if (fs.pathExistsSync(mockDir.resolve(input.Key))) {
        return {
          Body: Readable.from(fs.readFileSync(mockDir.resolve(input.Key))),
        };
      }

      throw new Error(`The file ${input.Key} does not exist!`);
    });

    s3Mock.on(HeadBucketCommand).callsFake(input => {
      if (input.Bucket === 'errorBucket') {
        throw new Error('Bucket does not exist');
      }
      return {};
    });

    s3Mock.on(ListObjectsV2Command).callsFake(input => {
      if (
        input.Bucket === 'delete_stale_files_success' ||
        input.Bucket === 'delete_stale_files_error'
      ) {
        return {
          Contents: [{ Key: 'stale_file.png' }],
        };
      }
      return {};
    });

    s3Mock.on(DeleteObjectCommand).callsFake(input => {
      if (input.Bucket === 'delete_stale_files_error') {
        throw new Error('Message');
      }
      return {};
    });

    s3Mock.on(UploadPartCommand).rejects();
    s3Mock.on(PutObjectCommand).callsFake(input => {
      mockDir.addContent({ [input.Key]: input.Body });
    });
  });

  afterEach(() => {
    process.env = env;
  });

  describe('buildCredentials', () => {
    it('should retrieve credentials for a specific account ID', async () => {
      await createReaderFromConfig();
      expect(getCredProviderMock).toHaveBeenCalledWith({
        accountId: '111111111111',
      });
      expect(getCredProviderMock).toHaveBeenCalledTimes(1);
    });

    it('should retrieve default credentials when no config is present', async () => {
      const mockConfig = new ConfigReader({
        techdocs: {
          reader: {
            type: 'awsS3',
            awsS3: {
              bucketName: 'bucketName',
            },
          },
        },
      });

      await AwsS3Read.fromConfig(mockConfig, logger);
      expect(getCredProviderMock).toHaveBeenCalledWith();
      expect(getCredProviderMock).toHaveBeenCalledTimes(1);
    });

    it('should fall back to deprecated method of retrieving credentials', async () => {
      const mockConfig = new ConfigReader({
        techdocs: {
          reader: {
            type: 'awsS3',
            awsS3: {
              credentials: {
                accessKeyId: 'accessKeyId',
                secretAccessKey: 'secretAccessKey',
              },
              bucketName: 'bucketName',
              bucketRootPath: '/',
            },
          },
        },
      });

      await AwsS3Read.fromConfig(mockConfig, logger);
      expect(getCredProviderMock).toHaveBeenCalledTimes(0);
    });
  });

  describe('getReadiness', () => {
    it('should validate correct config', async () => {
      const reader = await createReaderFromConfig();
      expect(await reader.getReadiness()).toEqual({
        isAvailable: true,
      });
    });

    it('should reject incorrect config', async () => {
      const reader = await createReaderFromConfig({
        bucketName: 'errorBucket',
      });
      expect(await reader.getReadiness()).toEqual({
        isAvailable: false,
      });
    });
  });

  describe('fetchTechDocsMetadata', () => {
    it('should return tech docs metadata', async () => {
      const reader = await createReaderFromConfig();
      expect(await reader.fetchTechDocsMetadata(entity)).toStrictEqual(
        techdocsMetadata,
      );
    });

    it('should return tech docs metadata even if the legacy case is enabled', async () => {
      const reader = await createReaderFromConfig({
        legacyUseCaseSensitiveTripletPaths: true,
      });
      expect(await reader.fetchTechDocsMetadata(entity)).toStrictEqual(
        techdocsMetadata,
      );
    });

    it('should return tech docs metadata even if root path is specified', async () => {
      const reader = await createReaderFromConfig({
        bucketRootPath: 'backstage-data/techdocs',
      });
      expect(await reader.fetchTechDocsMetadata(entity)).toStrictEqual(
        techdocsMetadata,
      );
    });

    it('should return tech docs metadata if root path is specified and legacy casing is used', async () => {
      const reader = await createReaderFromConfig({
        bucketRootPath: 'backstage-data/techdocs',
        legacyUseCaseSensitiveTripletPaths: true,
      });
      expect(await reader.fetchTechDocsMetadata(entity)).toStrictEqual(
        techdocsMetadata,
      );
    });

    it('should return tech docs metadata when json encoded with single quotes', async () => {
      const techdocsMetadataPath = path.join(
        directory,
        'techdocs_metadata.json',
      );
      const techdocsMetadataContent = files['techdocs_metadata.json'];

      fs.writeFileSync(
        techdocsMetadataPath,
        techdocsMetadataContent.replace(/"/g, "'"),
      );

      const reader = await createReaderFromConfig();

      expect(await reader.fetchTechDocsMetadata(entity)).toStrictEqual(
        techdocsMetadata,
      );

      fs.writeFileSync(techdocsMetadataPath, techdocsMetadataContent);
    });

    it('should return an error if the techdocs_metadata.json file is not present', async () => {
      const reader = await createReaderFromConfig();

      const fails = reader.fetchTechDocsMetadata(invalidEntity);

      await expect(fails).rejects.toMatchObject({
        message: expect.stringContaining(
          'The file invalid/triplet/path/techdocs_metadata.json does not exist',
        ),
      });
    });

    it('should return an error if the techdocs_metadata.json file cannot be read from stream', async () => {
      s3Mock.on(GetObjectCommand).callsFake(_ => {
        return {
          Body: new ErrorReadable('No stream!'),
        };
      });

      const reader = await createReaderFromConfig();

      const fails = reader.fetchTechDocsMetadata(invalidEntity);

      await expect(fails).rejects.toMatchObject({
        message: expect.stringMatching(
          'TechDocs metadata fetch failed; caused by Error: Unable to read stream; caused by Error: No stream!',
        ),
      });
    });
  });

  describe('docsRouter', () => {
    const entityTripletPath = `${entity.metadata.namespace}/${entity.kind}/${entity.metadata.name}`;

    let app: express.Express;

    it('should pass expected object path to bucket', async () => {
      // Ensures leading slash is trimmed and encoded path is decoded.
      const pngResponse = await request(app).get(
        `/${entityTripletPath}/img/with%20spaces.png`,
      );
      expect(Buffer.from(pngResponse.body).toString('utf8')).toEqual(
        'found it',
      );
      const jsResponse = await request(app).get(
        `/${entityTripletPath}/some%20folder/also%20with%20spaces.js`,
      );
      expect(jsResponse.text).toEqual('found it too');
    });

    it('should pass expected object path to bucket even if the legacy case is enabled', async () => {
      const reader = await createReaderFromConfig({
        legacyUseCaseSensitiveTripletPaths: true,
      });
      await reader.read({ entity, directory });
      app = express().use(reader.docsRouter());
      // Ensures leading slash is trimmed and encoded path is decoded.
      const pngResponse = await request(app).get(
        `/${entityTripletPath}/img/with%20spaces.png`,
      );
      expect(Buffer.from(pngResponse.body).toString('utf8')).toEqual(
        'found it',
      );
      const jsResponse = await request(app).get(
        `/${entityTripletPath}/some%20folder/also%20with%20spaces.js`,
      );
      expect(jsResponse.text).toEqual('found it too');
    });

    it('should pass expected object path to bucket if root path is specified', async () => {
      const rootPath = 'backstage-data/techdocs';
      const reader = await createReaderFromConfig({
        bucketRootPath: rootPath,
      });
      await reader.read({ entity, directory });
      app = express().use(reader.docsRouter());

      const pngResponse = await request(app).get(
        `/${entityTripletPath}/img/with%20spaces.png`,
      );
      expect(Buffer.from(pngResponse.body).toString('utf8')).toEqual(
        'found it',
      );
      const jsResponse = await request(app).get(
        `/${entityTripletPath}/some%20folder/also%20with%20spaces.js`,
      );
      expect(jsResponse.text).toEqual('found it too');
    });

    it('should pass expected object path to bucket if root path is specified and legacy case is enabled', async () => {
      const rootPath = 'backstage-data/techdocs';
      const reader = await createReaderFromConfig({
        bucketRootPath: rootPath,
        legacyUseCaseSensitiveTripletPaths: true,
      });
      await reader.read({ entity, directory });
      app = express().use(reader.docsRouter());

      const pngResponse = await request(app).get(
        `/${entityTripletPath}/img/with%20spaces.png`,
      );
      expect(Buffer.from(pngResponse.body).toString('utf8')).toEqual(
        'found it',
      );
      const jsResponse = await request(app).get(
        `/${entityTripletPath}/some%20folder/also%20with%20spaces.js`,
      );
      expect(jsResponse.text).toEqual('found it too');
    });

    it('should pass text/plain content-type for html', async () => {
      const htmlResponse = await request(app).get(
        `/${entityTripletPath}/html/unsafe.html`,
      );
      expect(htmlResponse.text).toEqual('<html></html>');
      expect(htmlResponse.header).toMatchObject({
        'content-type': 'text/plain; charset=utf-8',
      });

      const svgResponse = await request(app).get(
        `/${entityTripletPath}/img/unsafe.svg`,
      );
      expect(svgResponse.text).toEqual('<svg></svg>');
      expect(svgResponse.header).toMatchObject({
        'content-type': 'text/plain; charset=utf-8',
      });
    });

    it('should return 404 if file is not found', async () => {
      const response = await request(app).get(
        `/${entityTripletPath}/not-found.html`,
      );
      expect(response.status).toBe(404);

      expect(Buffer.from(response.text).toString('utf8')).toEqual(
        'File Not Found',
      );
    });

    it('should return 404 if file cannot be read from stream', async () => {
      s3Mock.on(GetObjectCommand).callsFake(_ => {
        return {
          Body: new ErrorReadable('No stream!'),
        };
      });

      const response = await request(app).get(
        `/${entityTripletPath}/not-found.html`,
      );
      expect(response.status).toBe(404);

      expect(Buffer.from(response.text).toString('utf8')).toEqual(
        'File Not Found',
      );
    });
  });
});

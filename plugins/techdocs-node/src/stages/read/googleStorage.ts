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
import { CompoundEntityRef, Entity } from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import { assertError } from '@backstage/errors';
import { Storage, StorageOptions } from '@google-cloud/storage';
import express, { Response } from 'express';
import JSON5 from 'json5';
import path from 'path';
import { Logger } from 'winston';
import {
  getHeadersForFileExtension,
  lowerCaseEntityTriplet,
  lowerCaseEntityTripletInStoragePath,
  normalizeExternalStorageRootPath,
} from './helpers';
import { ReaderBase, ReadinessResponse, TechDocsMetadata } from './types';

export class GoogleGCSRead implements ReaderBase {
  private readonly storageClient: Storage;
  private readonly bucketName: string;
  private readonly legacyPathCasing: boolean;
  private readonly logger: Logger;
  private readonly bucketRootPath: string;

  constructor(options: {
    storageClient: Storage;
    bucketName: string;
    legacyPathCasing: boolean;
    logger: Logger;
    bucketRootPath: string;
  }) {
    this.storageClient = options.storageClient;
    this.bucketName = options.bucketName;
    this.legacyPathCasing = options.legacyPathCasing;
    this.logger = options.logger;
    this.bucketRootPath = options.bucketRootPath;
  }

  static fromConfig(config: Config, logger: Logger): ReaderBase {
    let bucketName = '';
    try {
      bucketName = config.getString('techdocs.reader.googleGcs.bucketName');
    } catch (error) {
      throw new Error(
        "Since techdocs.reader.type is set to 'googleGcs' in your app config, " +
          'techdocs.reader.googleGcs.bucketName is required.',
      );
    }

    const bucketRootPath = normalizeExternalStorageRootPath(
      config.getOptionalString('techdocs.reader.googleGcs.bucketRootPath') ||
        '',
    );

    // Credentials is an optional config. If missing, default GCS environment variables will be used.
    // Read more here https://cloud.google.com/docs/authentication/production
    const credentials = config.getOptionalString(
      'techdocs.reader.googleGcs.credentials',
    );
    const projectId = config.getOptionalString(
      'techdocs.reader.googleGcs.projectId',
    );
    let credentialsJson: any = {};
    if (credentials) {
      try {
        credentialsJson = JSON.parse(credentials);
      } catch (err) {
        throw new Error(
          'Error in parsing techdocs.reader.googleGcs.credentials config to JSON.',
        );
      }
    }

    const clientOpts: StorageOptions = {};
    if (projectId) {
      clientOpts.projectId = projectId;
    }

    const storageClient = new Storage({
      ...(credentials && {
        projectId: credentialsJson.project_id,
        credentials: credentialsJson,
      }),
      ...clientOpts,
    });

    const legacyPathCasing =
      config.getOptionalBoolean(
        'techdocs.legacyUseCaseSensitiveTripletPaths',
      ) || false;

    return new GoogleGCSRead({
      storageClient,
      bucketName,
      legacyPathCasing,
      logger,
      bucketRootPath,
    });
  }

  /**
   * Check if the defined bucket exists. Being able to connect means the configuration is good
   * and the storage client will work.
   */
  async getReadiness(): Promise<ReadinessResponse> {
    try {
      await this.storageClient.bucket(this.bucketName).getMetadata();
      this.logger.info(
        `Successfully connected to the GCS bucket ${this.bucketName}.`,
      );

      return {
        isAvailable: true,
      };
    } catch (err) {
      assertError(err);
      this.logger.error(
        `Could not retrieve metadata about the GCS bucket ${this.bucketName}. ` +
          'Make sure the bucket exists. Also make sure that authentication is setup either by explicitly defining ' +
          'techdocs.reader.googleGcs.credentials in app config or by using environment variables. ' +
          'Refer to https://backstage.io/docs/features/techdocs/using-cloud-storage',
      );
      this.logger.error(`from GCS client library: ${err.message}`);

      return { isAvailable: false };
    }
  }

  fetchTechDocsMetadata(entity: Entity): Promise<TechDocsMetadata> {
    return new Promise((resolve, reject) => {
      const entityTriplet = `${entity.metadata.namespace}/${entity.kind}/${entity.metadata.name}`;
      const entityDir = this.legacyPathCasing
        ? entityTriplet
        : lowerCaseEntityTriplet(entityTriplet);

      const entityRootDir = path.posix.join(this.bucketRootPath, entityDir);

      const fileStreamChunks: Array<any> = [];
      this.storageClient
        .bucket(this.bucketName)
        .file(`${entityRootDir}/techdocs_metadata.json`)
        .createReadStream()
        .on('error', err => {
          this.logger.error(err.message);
          reject(err);
        })
        .on('data', chunk => {
          fileStreamChunks.push(chunk);
        })
        .on('end', () => {
          const techdocsMetadataJson =
            Buffer.concat(fileStreamChunks).toString('utf-8');
          resolve(JSON5.parse(techdocsMetadataJson));
        });
    });
  }

  /**
   * Express route middleware to serve static files on a route in techdocs-backend.
   */
  proxyDocs(decodedUri: string, res: Response, entity?: Entity) {
    // filePath example - /default/component/documented-component/index.html
    const filePathNoRoot = this.legacyPathCasing
      ? decodedUri
      : lowerCaseEntityTripletInStoragePath(decodedUri);

    // Prepend the root path to the relative file path
    const filePath = path.posix.join(this.bucketRootPath, filePathNoRoot);

    // Files with different extensions (CSS, HTML) need to be served with different headers
    const fileExtension = path.extname(filePath);
    const responseHeaders = getHeadersForFileExtension(fileExtension);

    // Pipe file chunks directly from storage to client.
    this.storageClient
      .bucket(this.bucketName)
      .file(filePath)
      .createReadStream()
      .on('pipe', () => {
        res.writeHead(200, responseHeaders);
      })
      .on('error', err => {
        this.logger.warn(
          `TechDocs Google GCS router failed to serve content from bucket ${this.bucketName} at path ${filePath}: ${err.message}`,
        );
        // Send a 404 with a meaningful message if possible.
        if (!res.headersSent) {
          res.status(404).send('File Not Found');
        } else {
          res.destroy();
        }
      })
      .pipe(res);
  }
}

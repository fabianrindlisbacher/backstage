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
import { Response } from 'express';
import JSON5 from 'json5';
import path from 'path';
import { SwiftClient } from '@trendyol-js/openstack-swift-sdk';
import { NotFound } from '@trendyol-js/openstack-swift-sdk/lib/types';
import { Stream, Readable } from 'stream';
import { Logger } from 'winston';
import { getHeadersForFileExtension } from './helpers';
import { ReaderBase, ReadinessResponse, TechDocsMetadata } from './types';
import { assertError, ForwardedError } from '@backstage/errors';

const streamToBuffer = (stream: Stream | Readable): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    try {
      const chunks: any[] = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    } catch (e) {
      throw new ForwardedError('Unable to parse the response data', e);
    }
  });
};

export class OpenStackSwiftRead implements ReaderBase {
  private readonly storageClient: SwiftClient;
  private readonly containerName: string;
  private readonly logger: Logger;

  constructor(options: {
    storageClient: SwiftClient;
    containerName: string;
    logger: Logger;
  }) {
    this.storageClient = options.storageClient;
    this.containerName = options.containerName;
    this.logger = options.logger;
  }

  static fromConfig(config: Config, logger: Logger): ReaderBase {
    let containerName = '';
    try {
      containerName = config.getString(
        'techdocs.reader.openStackSwift.containerName',
      );
    } catch (error) {
      throw new Error(
        "Since techdocs.reader.type is set to 'openStackSwift' in your app config, " +
          'techdocs.reader.openStackSwift.containerName is required.',
      );
    }

    const openStackSwiftConfig = config.getConfig(
      'techdocs.reader.openStackSwift',
    );

    const storageClient = new SwiftClient({
      authEndpoint: openStackSwiftConfig.getString('authUrl'),
      swiftEndpoint: openStackSwiftConfig.getString('swiftUrl'),
      credentialId: openStackSwiftConfig.getString('credentials.id'),
      secret: openStackSwiftConfig.getString('credentials.secret'),
    });

    return new OpenStackSwiftRead({ storageClient, containerName, logger });
  }

  /*
   * Check if the defined container exists. Being able to connect means the configuration is good
   * and the storage client will work.
   */
  async getReadiness(): Promise<ReadinessResponse> {
    try {
      const container = await this.storageClient.getContainerMetadata(
        this.containerName,
      );

      if (!(container instanceof NotFound)) {
        this.logger.info(
          `Successfully connected to the OpenStack Swift container ${this.containerName}.`,
        );
        return {
          isAvailable: true,
        };
      }
      this.logger.error(
        `Could not retrieve metadata about the OpenStack Swift container ${this.containerName}. ` +
          'Make sure the container exists. Also make sure that authentication is setup either by ' +
          'explicitly defining credentials and region in techdocs.reader.openStackSwift in app config or ' +
          'by using environment variables. Refer to https://backstage.io/docs/features/techdocs/using-cloud-storage',
      );
      return {
        isAvailable: false,
      };
    } catch (err) {
      assertError(err);
      this.logger.error(`from OpenStack client library: ${err.message}`);
      return {
        isAvailable: false,
      };
    }
  }

  async fetchTechDocsMetadata(entity: Entity): Promise<TechDocsMetadata> {
    return await new Promise<TechDocsMetadata>(async (resolve, reject) => {
      const entityRootDir = `${entity.metadata.namespace}/${entity.kind}/${entity.metadata.name}`;

      const downloadResponse = await this.storageClient.download(
        this.containerName,
        `${entityRootDir}/techdocs_metadata.json`,
      );

      if (!(downloadResponse instanceof NotFound)) {
        const stream = downloadResponse.data;
        try {
          const techdocsMetadataJson = await streamToBuffer(stream);
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
      } else {
        reject({
          message: `TechDocs metadata fetch failed, The file /rootDir/${entityRootDir}/techdocs_metadata.json does not exist !`,
        });
      }
    });
  }

  /**
   * Express route middleware to serve static files on a route in techdocs-backend.
   */
  async proxyDocs(decodedUri: string, res: Response, entity?: Entity) {
    // Files with different extensions (CSS, HTML) need to be served with different headers
    const fileExtension = path.extname(decodedUri);
    const responseHeaders = getHeadersForFileExtension(fileExtension);

    const downloadResponse = await this.storageClient.download(
      this.containerName,
      decodedUri,
    );

    if (!(downloadResponse instanceof NotFound)) {
      const stream = downloadResponse.data;

      try {
        // Inject response headers
        for (const [headerKey, headerValue] of Object.entries(
          responseHeaders,
        )) {
          res.setHeader(headerKey, headerValue);
        }

        res.send(await streamToBuffer(stream));
      } catch (err) {
        assertError(err);
        this.logger.warn(
          `TechDocs OpenStack swift router failed to serve content from container ${this.containerName} at path ${decodedUri}: ${err.message}`,
        );
        res.status(404).send('File Not Found');
      }
    } else {
      this.logger.warn(
        `TechDocs OpenStack swift router failed to serve content from container ${this.containerName} at path ${decodedUri}: Not found`,
      );
      res.status(404).send('File Not Found');
    }
  }
}

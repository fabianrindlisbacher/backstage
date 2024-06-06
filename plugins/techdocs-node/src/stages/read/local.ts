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
import { PluginEndpointDiscovery } from '@backstage/backend-common';
import {
  resolvePackagePath,
  resolveSafeChildPath,
} from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { Response } from 'express';
import os from 'os';
import path from 'path';
import { Logger } from 'winston';
import { ReaderBase, ReadinessResponse, TechDocsMetadata } from './types';
import {
  getHeadersForFileExtension,
  lowerCaseEntityTripletInStoragePath,
} from './helpers';
import fs from 'fs-extra';
import { Entity } from '@backstage/catalog-model';
import { ForwardedError } from '@backstage/errors';

/**
 * Local publisher which uses the local filesystem to store the generated static files. It uses by default a
 * directory called "static" at the root of techdocs-backend plugin unless a directory has been configured by
 * "techdocs.reader.local.publishDirectory".
 */
export class LocalRead implements ReaderBase {
  private readonly legacyPathCasing: boolean;
  private readonly logger: Logger;
  private readonly discovery: PluginEndpointDiscovery;
  private readonly staticDocsDir: string;

  constructor(options: {
    logger: Logger;
    discovery: PluginEndpointDiscovery;
    legacyPathCasing: boolean;
    staticDocsDir: string;
  }) {
    this.logger = options.logger;
    this.discovery = options.discovery;
    this.legacyPathCasing = options.legacyPathCasing;
    this.staticDocsDir = options.staticDocsDir;
  }

  static fromConfig(
    config: Config,
    logger: Logger,
    discovery: PluginEndpointDiscovery,
  ): ReaderBase {
    const legacyPathCasing =
      config.getOptionalBoolean(
        'techdocs.legacyUseCaseSensitiveTripletPaths',
      ) || false;

    let staticDocsDir = config.getOptionalString(
      'techdocs.reader.local.publishDirectory',
    );
    if (!staticDocsDir) {
      try {
        staticDocsDir = resolvePackagePath(
          '@backstage/plugin-techdocs-backend',
          'static/docs',
        );
      } catch (err) {
        // This will most probably never be used.
        // The try/catch is introduced so that techdocs-cli can import @backstage/plugin-techdocs-node
        // on CI/CD without installing techdocs backend plugin.
        staticDocsDir = os.tmpdir();
      }
    }

    return new LocalRead({
      logger,
      discovery,
      legacyPathCasing,
      staticDocsDir,
    });
  }

  async getReadiness(): Promise<ReadinessResponse> {
    return {
      isAvailable: true,
    };
  }

  async fetchTechDocsMetadata(entity: Entity): Promise<TechDocsMetadata> {
    let metadataPath: string;

    const namespace = entity.metadata.namespace
      ? entity.metadata.namespace
      : 'default';

    try {
      metadataPath = this.staticEntityPathJoin(
        namespace,
        entity.kind,
        entity.metadata.name,
        'techdocs_metadata.json',
      );
    } catch (err) {
      throw new ForwardedError(
        `Unexpected entity when fetching metadata: ${entity.metadata.namespace}/${entity.metadata.kind}/${entity.metadata.name}`,
        err,
      );
    }

    try {
      return await fs.readJson(metadataPath);
    } catch (err) {
      throw new ForwardedError(
        `Unable to read techdocs_metadata.json at ${metadataPath}. Error: ${err}`,
        err,
      );
    }
  }

  // TODO check if functionality is exactly the same
  proxyDocs(decodedUri: string, res: Response): void {
    const filePath = this.legacyPathCasing
      ? decodedUri
      : lowerCaseEntityTripletInStoragePath(decodedUri);

    const fullFilePath = path.join(this.staticDocsDir, filePath);

    // Check if file exists
    if (!fs.existsSync(fullFilePath)) {
      res.status(404).send(`File Not Found: ${fullFilePath}`);
      return;
    }

    // Set headers
    const fileExtension = path.extname(fullFilePath);
    const headers = getHeadersForFileExtension(fileExtension);
    for (const [header, value] of Object.entries(headers)) {
      res.setHeader(header, value);
    }

    // Stream the file content to the response
    const stream = fs.createReadStream(fullFilePath);
    stream.pipe(res);

    // Handle stream errors
    stream.on('error', err => {
      res.status(500).send(`Internal Server Error ${err}`);
    });
  }

  // docsRouter(): express.Handler {
  //   const router = express.Router();
  //
  //   // Redirect middleware ensuring that requests to case-sensitive entity
  //   // triplet paths are always sent to lower-case versions.
  //   router.use((req, res, next) => {
  //     // If legacy path casing is on, let the request immediately continue.
  //     if (this.legacyPathCasing) {
  //       return next();
  //     }
  //
  //     // Generate a lower-case entity triplet path.
  //     const [_, namespace, kind, name, ...rest] = req.path.split('/');
  //
  //     // Ignore non-triplet objects.
  //     if (!namespace || !kind || !name) {
  //       return next();
  //     }
  //
  //     const newPath = [
  //       _,
  //       namespace.toLowerCase(),
  //       kind.toLowerCase(),
  //       name.toLowerCase(),
  //       ...rest,
  //     ].join('/');
  //
  //     // If there was no change, then let express.static() handle the request.
  //     if (newPath === req.path) {
  //       return next();
  //     }
  //
  //     // Otherwise, redirect to the new path.
  //     return res.redirect(301, req.baseUrl + newPath);
  //   });
  //   router.use(
  //     ,
  //   );

  //   return router;
  // }

  /**
   * Utility wrapper around path.join(), used to control legacy case logic.
   */
  protected staticEntityPathJoin(...allParts: string[]): string {
    let staticEntityPath = this.staticDocsDir;

    allParts
      .map(part => part.split(path.sep))
      .flat()
      .forEach((part, index) => {
        // Respect legacy path casing when operating on namespace, kind, or name.
        if (index < 3) {
          staticEntityPath = resolveSafeChildPath(
            staticEntityPath,
            this.legacyPathCasing ? part : part.toLowerCase(),
          );
          return;
        }

        // Otherwise, respect the provided case.
        staticEntityPath = resolveSafeChildPath(staticEntityPath, part);
      });

    return staticEntityPath;
  }
}

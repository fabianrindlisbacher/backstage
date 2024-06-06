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
import { PluginEndpointDiscovery } from '@backstage/backend-common';
import { Logger } from 'winston';
import { Response } from 'express';

/**
 * Options for building Readers
 * @public
 */
export type ReaderFactory = {
  logger: Logger;
  discovery: PluginEndpointDiscovery;
};

/**
 * Key for all the different types of TechDocs Readers that are supported.
 * @public
 */
export type ReaderType =
  | 'local'
  | 'googleGcs'
  | 'awsS3'
  | 'azureBlobStorage'
  | 'openStackSwift';

/**
 * Result for the validation check.
 * @public
 */
export type ReadinessResponse = {
  /** If true, the Reader is able to interact with the backing storage. */
  isAvailable: boolean;
};

/**
 * Type to hold metadata found in techdocs_metadata.json and associated with each site
 * @param etag - ETag of the resource used to generate the site. Usually the latest commit sha of the source repository.
 * @public
 */
export type TechDocsMetadata = {
  site_name: string;
  site_description: string;
  etag: string;
  build_timestamp: number;
  files?: string[];
};

/**
 * Base class for a TechDocs Reader (e.g. Local, Google GCS Bucket, AWS S3, etc.)
 * The Reader handles publishing of the generated static files after the prepare and generate steps of TechDocs.
 * It also provides APIs to communicate with the storage service.
 *
 * @public
 */
export interface ReaderBase {
  /**
   * Check if the Reader is ready. This check tries to perform certain checks to see if the
   * Reader is configured correctly and can be used to read documentations.
   * The different implementations might e.g. use the provided service credentials to access the
   * target or check if a folder/bucket is available.
   */
  getReadiness(): Promise<ReadinessResponse>;

  /**
   * Retrieve TechDocs Metadata about a site e.g. name, contributors, last updated, etc.
   * This API uses the techdocs_metadata.json file that co-exists along with the generated docs.
   */
  fetchTechDocsMetadata(entity: Entity): Promise<TechDocsMetadata>;

  /**
   * Proxy middleware to serve static documentation files for an entity.
   */
  proxyDocs(decodedUri: string, res: Response, entity?: Entity): void;
}

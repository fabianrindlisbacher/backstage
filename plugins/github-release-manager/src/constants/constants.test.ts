/*
 * Copyright 2021 Spotify AB
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

import * as constants from './constants';

describe('constants', () => {
  it('should match snapshot', () => {
    expect(constants).toMatchInlineSnapshot(`
      Object {
        "DISABLE_CACHE": Object {
          "headers": Object {
            "If-None-Match": "",
          },
        },
        "SEMVER_PARTS": Object {
          "major": "major",
          "minor": "minor",
          "patch": "patch",
        },
        "VERSIONING_STRATEGIES": Object {
          "calver": "calver",
          "semver": "semver",
        },
      }
    `);
  });
});

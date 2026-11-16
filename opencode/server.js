/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

// The server part of the Open Code plugin: the package's "." export, loaded
// inside the Open Code server rather than run as a separate process.
//
// Everything that knows about Open Code lives under opencode/. lib/ stays the
// harness-free core it was under Claude Code, and this directory is the glue
// between the two. For now the glue registers nothing: setup() is empty, so the
// plugin loads and changes no behavior.
//
// The default export is a plain `{ id, setup }` object, not a call to
// `Plugin.define` from `@opencode/plugin`. `define` returns its argument
// unchanged, and the host loads a plain object the same way. The import would
// resolve inside Open Code, which supplies the package itself, and nowhere else:
// the plugin ships zero dependencies, so plain Node — `node --test` included —
// would refuse to load this file with ERR_MODULE_NOT_FOUND.

/** One name for the repository, the npm package and the plugin. */
const ID = 'opencode-pdkit';

export default {
  id: ID,
  setup() {},
};

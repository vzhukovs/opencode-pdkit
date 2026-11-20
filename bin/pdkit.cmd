@echo off
rem Copyright (C) 2026 Red Hat, Inc.
rem
rem Licensed under the Apache License, Version 2.0 (the "License");
rem you may not use this file except in compliance with the License.
rem You may obtain a copy of the License at
rem
rem http://www.apache.org/licenses/LICENSE-2.0
rem
rem Unless required by applicable law or agreed to in writing, software
rem distributed under the License is distributed on an "AS IS" BASIS,
rem WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
rem See the License for the specific language governing permissions and
rem limitations under the License.
rem
rem SPDX-License-Identifier: Apache-2.0

rem `pdkit` for PowerShell and cmd.exe on Windows.
rem
rem Open Code runs a shell command on Windows in PowerShell when it finds one,
rem in Git Bash only after that, and in cmd.exe last. Git Bash runs bin\pdkit
rem by its shebang; the other two do not run it at all. PowerShell finds it
rem and refuses it ("The operation attempted is not supported"), and cmd.exe
rem looks only for the extensions PATHEXT names. Both find this file under the
rem same bare name, `pdkit`. It runs bin\pdkit with the node on PATH, as the
rem shebang does, and its exit code is node's.
node "%~dp0pdkit" %*

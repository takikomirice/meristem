# Third-party notices

Meristem's original code and documentation are covered by the MIT License. The full text is in the repository's `LICENSE` and the VSIX's `extension/LICENSE.txt`. Third-party dependencies retain their own copyright notices and licenses.

## Direct npm dependencies

These versions and license identifiers come from `package-lock.json` and the installed packages. Install them with `npm ci --ignore-scripts`; their license files are retained in `node_modules`.

| Package | Version | License | Installed license file | Upstream |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | `node_modules/@modelcontextprotocol/sdk/LICENSE` | [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) |
| `yaml` | 2.8.2 | ISC | `node_modules/yaml/LICENSE` | [yaml](https://github.com/eemeli/yaml) |
| `zod` | 4.6.7 | MIT | `node_modules/zod/LICENSE` | [Zod](https://github.com/colinhacks/zod) |

## Development dependencies

| Package | Version | License | Installed license and notice files | Upstream |
|---|---|---|---|---|
| `typescript` | 5.9.3 | Apache-2.0 | `node_modules/typescript/LICENSE.txt`, `node_modules/typescript/ThirdPartyNoticeText.txt` | [TypeScript](https://github.com/microsoft/TypeScript) |
| `@types/node` | 24.19.2 | MIT | `node_modules/@types/node/LICENSE` | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) |
| `@types/vscode` | 1.95.0 | MIT | `node_modules/@types/vscode/LICENSE` | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/vscode) |

## Transitive dependencies and distribution

`package-lock.json` records the exact transitive dependency versions and license identifiers. Their installed packages contain the applicable license texts. The current lockfile uses MIT, ISC, BSD-2-Clause, BSD-3-Clause, and Apache-2.0 licenses. When redistributing installed dependencies or creating a bundle, retain the corresponding license and notice files; this summary does not replace them.

The local VSIX packager includes Meristem's compiled helper-extension JavaScript, extension manifest, project license, and this notice. It does not bundle `node_modules`, Codex, VS Code, Node.js, Git, or the .NET Framework.

The Windows runtime ZIP additionally includes the selected Windows x64 Node.js executable and the locked npm packages, including TypeScript because the installer uses its JSONC parser. Each package retains its original license and notice files. The selected Node executable is checked against the supplied official `win-x64/node.exe` checksum; its full version-specific license and third-party notices are included as `node/LICENSE.txt`, and its version and hash are recorded in `release-manifest.json`. Official Node.js release checksums are available from [nodejs.org/dist](https://nodejs.org/dist/); versioned license notices are in the [Node.js source repository](https://github.com/nodejs/node).

Codex, VS Code, Git, the .NET Framework, authentication material, and management state are not included in the runtime ZIP. Separately installed tools and services remain subject to their own terms.

Repository links in investigation records identify sources consulted during development; they do not make those projects part of Meristem's MIT license.

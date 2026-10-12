# Paper Lens

用 Codex 模型辅助阅读。 · [English](README.en.md)

一个由 [februarysea](https://github.com/februarysea) 开发的轻量 Zotero PDF 选区翻译插件。选中文字，即可查看译文、复制或保存到论文笔记。默认模型为 `gpt-6-luna`。Paper Lens 在 Zotero 中独立运行，通过自己的 ChatGPT OAuth 授权使用符合条件的订阅额度，无需启动 Codex。

首个公开版本为 **0.2.3 Beta**，目前正在准备发布。安装包将在 [GitHub Releases](https://github.com/februarysea/zotero-paper-lens/releases) 提供。清单支持 **Zotero 9**；维护者已在 macOS 验证 0.2.3 本地功能版的授权、实际翻译和重启后继续使用。Windows、Linux 和 Zotero 10 尚未完成实际使用验证，详细范围见 [发布说明](docs/releases/v0.2.3.md)。

## 安装与使用

1. 从 Releases 下载 `paper-lens-0.2.3.xpi`。若已有 ID 为 `paper-lens@local` 的开发版，先禁用或卸载旧版，避免两份同时运行。在 Zotero 的「工具 → 插件」中，点击齿轮菜单，选择「从文件安装插件」，打开下载的 XPI。
2. 打开「Zotero 设置 → Paper Lens」，点击「使用 ChatGPT 继续」。在系统浏览器中登录，确认授予 Paper Lens 使用 ChatGPT 订阅额度的权限，然后返回 Zotero。
3. 授权成功后，设置页显示连接状态，并读取当前账号可用的模型。默认选择 `gpt-6-luna`；若账号未提供此模型，会明确提示，请自行选择其他模型。
4. 打开 PDF，选中文字后在浮动菜单中点击「翻译」，或从「工具 → Paper Lens」打开面板，再点击「翻译选区」。
5. 译文同时逐步显示在划词浮动框和右侧阅读面板中。浮动框中的长译文可滚动、复制或停止生成；右侧面板还可重试或保存到当前论文的子笔记。独立 PDF 的笔记通过 Related 关联。两处共用一次模型请求。

在「Zotero 设置 → Paper Lens」中可开启「选中文字后自动翻译」，默认关闭。开启后，选区稳定约 350 毫秒且鼠标松开时，自动打开阅读面板并翻译；快速重新划选只翻译最新选区，重复弹窗不会重复发送。关闭开关或切换标签页会取消待发送的翻译，重新划选会中止上一条请求。开启此功能后，选区会自动发送到所用模型服务。

名称始终是 Paper Lens。界面随 Zotero 语言自动切换：中文界面使用中文文案，其他语言回退英文。翻译目标也随界面语言切换：中文界面译为中文，英文界面译为英文。

模型选择只保存在 Paper Lens。每个选项显示实际请求使用的 model ID，使用时无需启动 Codex 或额外的后台服务。第一版范围仅为选区翻译。

## 登录、额度与凭据

0.2.3 采用 OpenAI 的开源本地应用授权流程。首次授权通过动态注册生成 Paper Lens 的独立 client ID；后续登录复用该账号的注册与本机标识。通过 OAuth PKCE、本地随机端口回调、state/nonce 校验，以及 OpenAI JWKS 的 ID-token 签名、发行方和受众校验确认身份。

登录身份和使用订阅额度是不同权限。只登录但未授权额度时，插件会保留连接并提示重新授权，不发送翻译请求。账号是否支持此流程、模型权限和限额，取决于 OpenAI 的资格、工作区和服务设置。请求消耗账号的共享额度，可通过设置页「管理额度」进入 ChatGPT 设置。

凭据仅保存在当前 Zotero profile 的 `paper-lens/auth.json`，与文库和 Zotero 同步目录分离。文件原子写入，Unix 目录权限为 `0700`、文件为 `0600`。每个注册的账号独立保存；切换账号不会混用 client ID 和 token。凭据不进入代码、日志、笔记或诊断输出。

到期时自动刷新并保存替换的 token。明确失效的刷新凭据会清除，临时网络或服务故障不会清除登录。退出登录会尝试撤销远程会话并清空本地 token；撤销未确认时会提示在 ChatGPT 设置中手动断开。卸载前建议先退出登录；卸载本身不会自动删除本地注册记录或撤销远程授权。

从 0.1.5 升级后，需要在 Paper Lens 设置中单独授权一次。原先的 Codex 登录文件、配置和模型缓存不再读取或修改，旧的高级登录文件位置设置不再使用。

## 网络与上下文

模型目录读取 `GET https://api.openai.com/v1/models`，翻译使用 `POST https://api.openai.com/v1/responses`。请求使用 `store: false` 和 `stream: true`，仅文本生成，不提供工具。认证只发送到固定 OpenAI 服务地址，拒绝重定向。

论文选区、少量邻近正文、可用摘要和基本来源信息会发送给 OpenAI。每次翻译独立，不发送历史译文，不上传 PDF 文件，不遍历整个文库。通过 ChatGPT 授权时的数据处理遵循对应账号或工作区的政策，`store: false` 不应被解释为零保留承诺。

维护者不提供中转服务器、遥测或分析服务。保存的笔记会进入 Zotero 文库，并遵循你的同步设置。详见 [隐私说明](PRIVACY.md)。Paper Lens 是独立项目，与 Zotero、OpenAI 没有官方隶属关系。

- 保留完整选区，最多附带约 1,200 字符邻近正文和可用摘要，用于术语消歧义；模型只输出译文。
- 面板显示上下文范围。总提示默认最多 24,000 字符；超长选区会提示缩小范围，不默默截断原文。
- 各 PDF 的选区和最近译文独立保存在当前 Zotero 会话。保存的笔记会持久保留，并包含选区、译文、模型和原文链接。

正文来自 Zotero 的 PDF 文本提取。扫描版尚无 OCR，必须能选中文字才能翻译；正文提取不可用时，仍可翻译已有选区，面板会说明范围。基础 Markdown 可显示，数学公式保留 LaTeX 原文，尚无图片理解或公式排版。仅有真实 PDF 页索引时添加页码。

## 本地开发与分发

运行时使用 Zotero 原生能力，没有 npm 运行时依赖。开发需要 Python 3.10+、Node.js 18+，无需执行 `npm install`。GitHub Actions 使用 Node.js 24 和 Python 3.13。

```sh
npm run check
npm test
npm run test:release
npm run release:prepare
```

`release:prepare` 在 `dist/` 生成 XPI、SHA-256、候选更新清单、构建元数据和发布确认材料，不执行上传。`npm run build` 可单独构建安装包。`scripts/preview.html` 使用实际面板代码和模拟译文，可用于检查中英文、窄面板及深浅主题。

`addon/content/` 中的 `oauth.js`、`loopback.js`、`auth.js` 负责授权与凭据，`settings.js` 负责账号模型目录，`codex.js` 负责公开 Responses API，`context.js` 和 `ui.js` 负责上下文与显示，`preferences.js` 管理原生设置页。

Beta 与稳定版使用固定插件 ID `paper-lens@februarysea.github.io`，更新清单分别为 `updates-beta.json` 和 `updates.json`。稳定版不会自动收到 Beta。渠道清单只在对应 Release 公开并验证下载后更新。旧开发版的 ID 和更新地址不同，首次迁移需要手动安装；既有 `extensions.paperlens.*` 设置和 Paper Lens profile 授权记录会保留。

CI 执行检查与构建；手动 Beta 工作流只创建 GitHub Release 草稿。公开发布需维护者确认，随后验证已发布文件，再更新渠道清单。完整流程见 [发布指南](docs/RELEASING.md)；参与开发见 [贡献指南](CONTRIBUTING.md)。

参考：[OpenAI 开源应用授权](https://developers.openai.com/siwc/token-sharing-open-source)、[注册和登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型与请求规范](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[Zotero 插件说明](https://www.zotero.org/support/plugins)。

MIT License · Copyright © 2026 februarysea

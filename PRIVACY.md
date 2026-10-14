# Privacy / 隐私说明

Applies to Paper Lens 0.2.x. / 适用于 Paper Lens 0.2.x。

## 发送哪些数据

翻译请求直接发送到 OpenAI 的 `https://api.openai.com/v1/responses`。请求包括完整选区、有限邻近正文（最多约 1,200 字符）、可用摘要（最多 1,600 字符）、论文标题和作者、可用的附件 key 和真实页码，以及说明本次材料范围的信息。总提示默认最多 24,000 字符。每次请求独立，不发送历史译文或 PDF 文件，不批量处理文库。

自动翻译默认关闭；开启后，稳定选区会自动发送。手动翻译则在点击翻译后发送。模型服务是 OpenAI，Paper Lens 维护者不运行代理、中转、遥测或分析服务器。

模型目录从 `https://api.openai.com/v1/models` 读取；登录、刷新和撤销使用固定 OpenAI 授权服务。凭据请求拒绝重定向。浏览器登录通过本机随机端口回调，回调监听仅在授权期间运行。

## 本地保留哪些数据

授权记录、账号标识、应用注册信息和 token 保存在当前 Zotero profile 的 `paper-lens/auth.json`，不写入文库或同步目录。使用原子写入，Unix 目录权限为 `0700`、文件权限为 `0600`。Paper Lens 不读取或修改 Codex 的登录与配置。

模型和自动翻译开关保存在 Zotero 的 `extensions.paperlens.*` 设置中。选区与最近译文保留在当前会话，保存到笔记后则持久保留在 Zotero 文库；笔记包含原文、译文、模型与来源链接，可能随你的 Zotero 设置同步。

退出登录会清除该账号的本地 token，并尝试撤销远程会话。撤销未确认时，设置页会提示去 ChatGPT 设置手动断开。账号的非 token 注册记录会保留以供后续登录。卸载不会自动删除 profile 中的文件或撤销远程授权；如需清除残留，可在退出登录并关闭 Zotero 后删除 profile 中的 `paper-lens` 文件夹。

## 服务端处理与更新

请求使用 `store: false`，这不等于所有服务端数据零保留。账号资格、用量、数据保留和训练规则取决于对应 ChatGPT 账号、工作区及 OpenAI 政策。参见 [OpenAI 的模型请求说明](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。

Zotero 的插件更新检查会访问 GitHub 托管的渠道清单，安装更新时下载 GitHub Release 文件。GitHub 会接收常规网络请求信息，例如 IP 地址；该流程不附带论文内容或 OpenAI 凭据。

反馈问题时，请提供版本、复现步骤和非敏感错误码，不要上传授权文件、token、登录回调地址或私人论文内容。

## English

Translations go directly to OpenAI's Responses API. Requests contain the complete selected text, up to about 1,200 characters of nearby body text, up to 1,600 characters of an available abstract, title and authors, optional attachment key/page metadata, and a coverage description. The default prompt limit is 24,000 characters. Previous translations, PDF files and whole-library contents are not uploaded. Automatic translation is off by default; enabling it sends stable selections automatically.

Paper Lens runs no maintainer relay, telemetry or analytics service. Model discovery, authorization, refresh and revocation use OpenAI services. Authenticated requests refuse redirects. A temporary loopback callback runs during sign-in.

Credentials and account registrations are stored in `paper-lens/auth.json` in the current Zotero profile, outside library sync. Writes are atomic, with Unix permissions `0700` for the directory and `0600` for the file. Codex files are not accessed. Model/automatic-translation preferences use Zotero settings. Recent translations are session state; saved notes persist in the library and may sync according to your Zotero settings.

Sign-out clears local tokens and attempts remote revocation. If revocation is unconfirmed, disconnect the app in ChatGPT settings. Non-token registration records remain for future sign-in. Uninstalling alone does not revoke authorization or remove profile files. To remove local records, sign out, close Zotero, and delete the profile's `paper-lens` directory.

Requests use `store: false`, which is not a zero-retention guarantee. OpenAI account/workspace policies govern eligibility, usage, retention and training. Zotero updates access GitHub manifests and release assets with ordinary request metadata, without paper text or OpenAI credentials. Do not include credentials, callback URLs or private paper text in issue reports.

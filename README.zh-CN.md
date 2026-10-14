# Paper Lens

[English](README.md) · [简体中文](README.zh-CN.md)

在 Zotero 中使用 Codex 模型翻译 PDF 选区。

## 功能

- 在划词浮动框和 Zotero 阅读面板中查看译文。
- 复制、停止、重试，或将译文保存为论文笔记。
- 按需开启自动翻译，选中文字即可翻译。
- 中英文界面随 Zotero 语言切换。

## 安装

需要 **Zotero 9 或 10**，目前已在 macOS 的 Zotero 中验证。

从 [Releases 页面](https://github.com/februarysea/zotero-paper-lens/releases)下载最新 Beta 安装包。

1. 从 Releases 下载 `.xpi` 安装包。
2. 打开 Zotero「工具 → 插件」，点击齿轮图标，选择「从文件安装插件」。
3. 选择下载的文件，然后打开「Zotero 设置 → Paper Lens」。
4. 点击「使用 ChatGPT 继续」，在浏览器中完成登录和授权，然后返回 Zotero。

## 使用

打开 PDF，选中一段文字，点击划词浮动框中的「翻译」。译文会逐步显示，可以直接复制，也可以在阅读面板中重试或保存为笔记。

也可以从「工具 → Paper Lens」打开面板，再点击「翻译选区」。

需要自动翻译时，在「Zotero 设置 → Paper Lens」中开启「选中文字后自动翻译」。此选项默认关闭；开启后，选中文字会自动开始翻译。

翻译目标随界面语言切换：中文 Zotero 界面译为中文，其他语言界面译为英文。PDF 需要包含可以选中的文字。

## ChatGPT 账号与模型

Paper Lens 使用你的 ChatGPT 账号。登录时，请确认允许 Paper Lens 使用订阅额度进行翻译。登录状态保存在当前电脑上，使用时无需启动 Codex。

翻译会使用 ChatGPT 订阅的共享额度，可用模型和限额取决于你的账号。点击 Paper Lens 设置中的「管理额度」，即可在 ChatGPT 中查看或管理用量。

默认模型为 **`gpt-6-luna`**，可在「Zotero 设置 → Paper Lens」的模型下拉菜单中调整。如果账号不支持默认模型，请选择其他可用模型。

随时可以在同一设置页面退出登录。

## 反馈

问题和建议可以提交到 [GitHub Issues](https://github.com/februarysea/zotero-paper-lens/issues)。反馈故障时，请附上 Zotero 版本、操作系统和复现步骤。

本插件由 Codex 使用 GPT-6.1 Sol（Ultra）完成，[@februarysea](https://github.com/februarysea) 仅提供思路。

[隐私说明](PRIVACY.md) · [MIT 许可](LICENSE)

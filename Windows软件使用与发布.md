# 主播双语字幕：Windows软件使用与发布

## 下载与安装

从[GitHub Releases](https://github.com/humerus-sketch/streamer-bilingual-subtitles/releases)下载`BilibiliSubtitle-版本-Setup.exe`，双击“安装并启动”。不需要安装Node.js、Python或手工运行脚本，也不需要GitHub账号。

软件安装到`%LOCALAPPDATA%\Programs\BilibiliSubtitle`，开始菜单和桌面“主播双语字幕软件版”提供固定入口。首次设置可以选择已有Python、Whisper、声纹模型和Codex路径，也可以点击“下载并安装识别环境”。大型模型拆分由软件自动下载、拼接和校验，不必手动合并。

首次下载约4GiB，建议至少预留12GiB空间。环境和模型下载一次，之后程序更新不重复下载。Codex已有官方登录会直接沿用；新电脑使用自己的账号完成一次官方CLI登录，软件不携带任何账号或Token。Codex安装和登录方式参见[OpenAI官方CLI文档](https://learn.chatgpt.com/docs/codex/cli)。

## 环境要求

- Windows 10/11 x64、.NET Framework 4.8、WebView2 Evergreen Runtime。缺WebView2时软件设置窗口仍可使用，并提供微软官方下载入口。
- NVIDIA显卡及兼容CUDA 12运行库的驱动；当前large-v3使用FP16，建议至少8GiB显存。CUDA运行依赖随环境包提供，无需另装CUDA Toolkit；未验证AMD、Intel GPU或无独显电脑。
- 内存建议16GiB以上；麦克风需被Windows允许访问桌面应用。
- 下载依赖和云翻译需要网络，翻译使用用户自己的Codex/ChatGPT账户。未承诺所有账户均可使用同一模型。

## 使用和数据位置

选择麦克风与翻译模型，按界面登记本人声纹，再点击开始采音。启动软件不会自动开启麦克风。日语识别完成后，Codex按模型复用会话，生成完整中英文后一次显示字幕。没有修改既有识别/翻译模型、提示词和80%策略。

模型与运行环境默认位于`%LOCALAPPDATA%\BilibiliSubtitlePrototype\models`、`runtime`；设置在`desktop.settings.json`；个人声纹和运行记录在`data`；WebView2用户目录在`WebView2`。Codex登录仍由官方CLI管理，软件不读取或复制登录文件。

安装、更新不会把测试TTS声纹当成本人登记。历史D11包及原工作区模型不删除。软件卸载仅删除程序和软件版快捷方式，保留模型、设置、声纹、运行记录和Codex登录。

## 软件内更新

打开“软件设置与更新”，点击“检查GitHub更新”。有新正式版本时，点击“下载并安装更新”：

1. 从固定公开仓库读取正式Release，下载相应Windows x64程序ZIP。
2. 按GitHub asset digest核对实际大小和SHA-256；失败不进入安装。
3. 正常停止采音、已提交翻译和后台进程。无法正常停止则取消本次安装。
4. 独立辅助程序等待GUI退出，重新核验并安全解压到新的版本目录。
5. 原子切换`current.json`，启动固定入口。旧版本和旧指针保留；新程序缺失、无法加载或立即异常退出时尝试回退。

回退只针对启动失败，不代表检测翻译质量。组件和模型独立于程序更新：以后发布程序不必重新上传模型，新程序沿用`componentsReleaseTag`指定的既有组件Release。GitHub公开Release可免登录读取，单附件须小于2GiB，依据[GitHub Releases官方说明](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)及[API文档](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)。

## 开发和发布

保留当前C#/.NET Framework、Node和Python结构，不进行框架重写。`desktop`是原生桌面容器，`software`是安装/更新/资产打包，`worker.py`负责语音处理，`gateway.mjs`负责CLI调度和字幕推送。

在Windows PowerShell中运行`tools/mic-prototype/software/Build-Distribution.ps1 -Version 0.1.1 -OutputDirectory 新目录`，得到安装EXE、程序ZIP和SHA256SUMS。版本必须递增，构建不会覆盖已有目录。将程序ZIP和安装EXE上传到新正式GitHub Release，tag使用`v0.1.1`；程序更新不能仅上传源码ZIP。

首次环境包使用`Build-Assets.ps1`从已验证的独立CPython及锁定依赖构建，`Validate-Assets.ps1`负责搬迁后的真实识别/声纹验证。不要直接分发venv、整个模型缓存目录或个人profile。第三方许可、固定源码及构建配方随资源包保留。

GitHub Actions的`Windows software build`可手动构建，默认仅提供构建产物；显式选择publish后才创建Release。远程构建通过编译不等于真实Windows音频链路通过，正式发布仍应保留本地安装和更新验证。

## 当前边界

这是功能预览软件。上一轮声纹误拒、ASR语义错误和云翻译长尾没有因软件打包而消失，尚未达到稳定三秒双语字幕。EXE未购买代码签名证书；SHA-256校验验证下载完整性，不等于发布者数字签名。模型/运行库的各自许可与限制以包内原文为准，不统一宣称为MIT。

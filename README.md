# 主播双语字幕

Windows桌面软件，将主播麦克风的日语讲话识别并翻译为简体中文和英文；支持Codex CLI模型切换、持续会话和软件内GitHub更新。

**[下载安装包](https://github.com/humerus-sketch/streamer-bilingual-subtitles/releases/latest)** · [使用与发布说明](Windows软件使用与发布.md) · [提交问题](https://github.com/humerus-sketch/streamer-bilingual-subtitles/issues)

## 安装

1. 在Releases下载`BilibiliSubtitle-版本-Setup.exe`，运行“安装并启动”。
2. 首次在“软件设置与更新”下载环境和模型，或选择已有Python/模型目录；无需先安装Node或Python。
3. 已有官方Codex登录会自动沿用。新电脑用自己的ChatGPT账号完成一次Codex登录，软件不提供共享账号或Token。
4. 选择麦克风和翻译模型，登记本人声纹后开始。软件启动不会自动采音。

建议Windows 10/11 x64、16GiB内存、NVIDIA显卡至少8GiB显存及可用驱动、.NET Framework4.8和WebView2 Runtime。当前Whisper FP16路径未验证AMD/Intel GPU或纯CPU环境。首次资源下载约4GiB，建议至少12GiB剩余空间。

## 功能

- 原生Windows窗口与内嵌字幕界面，不要求反复打开浏览器。
- 本地Whisper large-v3 FP16识别、可登记的CAM++声纹准入；默认原声，不做音频增强。
- Codex CLI按模型保留会话，每次新建完整加载翻译指令，当前句参考前句最终中英译文；完整双语生成后显示。
- 可切换账户实际可用的翻译模型；不承诺每个账号都有同一模型权限。
- 软件内检查公开GitHub正式Release、下载校验、停止后台后安装重启；程序、运行环境、模型和用户数据分离。
- 旧版本保留供启动失败回退，模型、设置、声纹、运行记录和Codex登录不会随程序更新覆盖。

## 更新

在“软件设置与更新”点击“检查GitHub更新”，发现新版后选择“下载并安装更新”。不需要GitHub登录。更新校验来源、版本、文件大小与SHA-256，拒绝损坏包与不安全ZIP路径；安装前正常停止字幕服务。

首次识别环境由`components-1.json`固定资源清单管理，大模型分块由软件处理。以后程序升级沿用组件Release，不重复下载模型。下载可以取消，取消不会进入安装。

## 源码和构建

```text
tools/mic-prototype/
  desktop/               Windows原生窗口、WebView2、后台生命周期
  software/              Setup、版本入口、GitHub更新、资源构建与测试
  worker.py              音频切分、日语识别
  speaker_admission.py   声纹准入
  gateway.mjs            翻译会话、保序和双语字幕
tools/siwc-probe/        现有运行模块依赖；当前翻译默认Codex CLI
```

Windows PowerShell构建：

```powershell
& tools/mic-prototype/software/Build-Distribution.ps1 -Version 0.1.1 -OutputDirectory .runtime/release-0.1.1
```

生成安装EXE、程序ZIP与SHA256SUMS。GitHub Actions支持手动构建，默认不发布；显式选择publish后创建新Release。首次模型/环境资源由维护者独立验证后上传，普通更新不重新打包。

核心Node测试：

```powershell
node --test tools/mic-prototype/desktop/host.test.mjs tools/mic-prototype/software/updates.test.mjs tools/mic-prototype/codex-resident.test.mjs tools/mic-prototype/translation-context.test.mjs
```

完整使用、目录、更新和发布说明见[Windows软件使用与发布](Windows软件使用与发布.md)。历史评测数据、个人录音、配置、登录文件和本地模型缓存不属于此源码仓库。

## 当前边界与第三方组件

当前为功能预览，识别误拒、识别错误和云翻译长尾仍需改进，尚未达到稳定三秒双语字幕。软件打包不代表准确性或延迟目标已经通过。

EXE尚无商业代码签名证书。Python、Node、WebView2、Whisper、CAM++、Codex及媒体/GPU库各有原始许可；原文、固定来源、相应源码和构建配方随发布资源保留。SHA校验验证下载完整性，不等于发布者数字签名。本项目不是Bilibili、OpenAI或微软的官方软件。

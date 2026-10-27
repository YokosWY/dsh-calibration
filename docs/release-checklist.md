# 发布清单（发版 / 上传前全盘自检）

> 起因（v2.2.2 前）：v2.2.0 加了「检索」、v2.2.1 修了配色，仓库里的文档都被一致性测试守着，**GitHub 的 About 却没人管**——它只存在仓库设置里，任何离线测试都碰不到它，于是发了两版，首页还写着「一框三模式」。
> 规矩：**About、Topics、Release 也算仓库的一部分**，发版必须一起走这张表；漏一项就是没发完。

## 一、唯一事实源

| 表面 | 事实源 | 谁来保证 |
|---|---|---|
| GitHub About（首页那句） | `package.json` 的 `description`，**逐字复制** | 测试守 `description` 的措辞；About 本身只能人工/API 同步 |
| GitHub Topics | 本文件 §三 的列表 | 人工/API |
| README 头部、四模式图 | `README.md` | 一致性测试 |
| 演示图 | `docs/demo.svg`（`docs/demo.png` 由它重渲染） | 测试守 svg 标题，png 需重出 |
| 使用说明 | `docs/使用说明.md` → `docs/使用说明.docx`（`python docs/tools/build-usage-docx.py`，需 python-docx） | 人工跑脚本，跑完看 `git status` 里 docx 是否变化 |
| Release 正文 | `docs/release-notes.md` 里该版本那一节 | 测试守「首节 = 当前版本」 |
| 版本号 | `package.json` ↔ `CHANGELOG.md` 首条 | 一致性测试 |
| tag / GitHub Release | 与 `release-notes` 该节同名同文 | 人工 |

## 二、发布动作（按顺序）

1. 版本号：`package.json`、`CHANGELOG.md` 首条、`docs/release-notes.md` 顶部 `## vX.Y.Z — 一句话`，三处同号
2. 本地自检：`npm run verify`（语法检查 + 全部测试）
3. **About 同步：把 `package.json` 的 `description` 逐字贴进 GitHub About**；Topics 按 §三
4. 提交并推送 `main`；等 CI 绿
5. 打 tag（带注释，注解 `vX.Y.Z — 一句话`）并推送
6. 建 Release：名字与正文取 `release-notes` 该节
7. 回读验收：API 读一次 About/Topics；打开 Release 页面看正文与 tag

## 三、Topics（保持这 10 个）

`clarify` `deepseek-harness` `dsh` `dsh-plugin` `loop-forge` `plugin` `red-team` `ui` `skill-search` `retrieval`

## 四、两套 DSH 的副本

- 主装：`D:\AI\DSH-NEXT\local-plugins\dsh-calibration`（NEXT 用，profile 里是 link，改文件即生效）
- 副本：`D:\AI\DSH-official\home\local-plugins\dsh-calibration`（官方 DSH，当前 v2.0.0，无检索功能，也未含 2.1/2.2 的改动）
- 两套默认隔离：**同步要用户开口**；同步时整目录覆盖并重跑 `npm run verify`

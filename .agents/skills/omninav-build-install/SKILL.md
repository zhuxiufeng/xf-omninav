---
name: omninav-build-install
description: 自动执行 XF OmniNav（及 VS Code / Antigravity IDE 插件）代码构建、运行测试、打包生成 .vsix 安装包，并自动热部署安装到 Antigravity IDE (WSL) 与 VS Code (WSL) 扩展目录。当用户要求构建插件、安装到 Antigravity、重新发布、测试打包、或在每次完成代码修改与功能更新后自动化部署生效时使用此技能。
---

# OmniNav 自动构建与 Antigravity IDE 安装部署技能 (omninav-build-install)

本技能用于在对 `omninav`（`xf-omninav`）插件完成功能迭代、性能调优、代码重构或缺陷修复后，自动化完成全流程质量保障（运行单元测试）、生产编译（esbuild）、VSIX 安装包生成，并一键热部署安装至 Antigravity IDE (WSL) 与 VS Code (WSL) 环境中，避免手动执行繁琐命令行。

---

# 核心职责与触发时机

**1. 触发时机**
- **功能迭代闭环**：在每次完成用户交办的插件功能开发、性能优化或 Bug 修复后，主动触发本技能进行编译打包与本地安装生效。
- **用户显式指令**：当用户下达类似“构建”、“安装到 antigravity”、“重新发布”、“package”、“打包插件”、“帮我更新一下插件”等指令时立即执行。
- **本地调试验证**：开发过程中需要快速验证新功能在真实 IDE 界面中的渲染表现时。

**2. 核心执行流程**
1. **自动化前置单测校验**：运行 `npm test`，确保全部测试用例 100% 通过，防止带病打包。
2. **生产环境编译**：调用 `npm run compile`（执行 `node esbuild.js --production`），输出无依赖高性能 JS bundle。
3. **标准 VSIX 封包**：调用 `npx --yes @vscode/vsce package --no-dependencies`，打出最新版本 `.vsix` 文件。
4. **多 IDE 自动热安装部署**：
   - 自动检测并解压安装到 Antigravity IDE 扩展目录：`~/.antigravity-ide-server/extensions/vivian.xf-omninav-<version>`
   - 自动同步到 Antigravity Server 扩展目录：`~/.antigravity-server/extensions/`
   - 自动同步到 VS Code Server 扩展目录：`~/.vscode-server/extensions/`
   - 自动调用 `code --install-extension <vsix> --force` 刷新宿主注册表。
5. **历史残留清理与环境自愈**：
   - 自动识别并删除旧版本历史目录（如 `vivian.xf-omninav-1.0.18`、`vivian.xf-omninav-1.0.5` 等），防止目录冲突与旧版本覆盖。
   - 输出操作报告，并提醒用户执行 `Developer: Reload Window` 重载窗口即刻生效。

---

# 维护说明与软链接源文件映射

根据规范要求，Skill 内部脚本采用符号软链接（Symlink）实时同步工作区源文件，切勿使用普通文件覆盖软链接。

**软链接映射关系表**

| Skill 内部路径 | 软链接指向的工作区源文件绝对路径 | 作用说明 |
| :--- | :--- | :--- |
| `scripts/build_and_install.py` | `/home/zxf/workspace/code/agy/guitool/extension/omninav/scripts/build_and_install.py` | 插件自动化编译、单测、打包与多 IDE 热安装脚本 |

> [!IMPORTANT]
> 如需修改构建或安装逻辑（如调整目标 IDE 路径或打包参数），请直接编辑工作区源文件 `/home/zxf/workspace/code/agy/guitool/extension/omninav/scripts/build_and_install.py`，Skill 内部脚本将实时自动同步。

---

# 命令行使用说明

**1. 常用命令**

```bash
# 1. 标准流程：运行测试 -> 编译 -> 打包 -> 自动热安装到 Antigravity IDE 与 VS Code
python3 scripts/build_and_install.py

# 2. 版本号自动 +1（Patch 位自增）并构建安装
python3 scripts/build_and_install.py --bump

# 3. 指定版本号并构建安装
python3 scripts/build_and_install.py --set-version 1.0.20

# 4. 跳过单测快速构建安装
python3 scripts/build_and_install.py --skip-test

# 5. 仅将现有的最新 .vsix 安装到全部 IDE（不重新打包）
python3 scripts/build_and_install.py --only-install
```

---
name: omninav-build-install
description: 自动执行 XF OmniNav（及 VS Code / Antigravity IDE 插件）代码构建、运行测试、打包生成 .vsix 安装包，并通过 IPC 套接字直连正在运行的 Antigravity IDE 窗口进行无感热重载部署。当用户要求构建插件、安装到 Antigravity、重新发布、测试打包、或在每次完成代码修改与功能更新后自动化部署生效时使用此技能。
---

# OmniNav 自动构建与 Antigravity IDE 安装部署技能 (omninav-build-install)

本技能用于在对 `omninav`（`xf-omninav`）插件完成功能迭代、性能调优、代码重构或缺陷修复后，自动化完成全流程质量保障（运行单元测试与真实 Klipper 集成测试）、生产编译（esbuild）、VSIX 安装包生成，并通过实时 IPC 套接字直连正在运行的 Antigravity IDE 窗口实现无感热重载与多环境分发，避免手动执行繁琐命令行。

---

# 核心职责与触发时机

**1. 触发时机**
- **功能迭代闭环**：在每次完成用户交办的插件功能开发、性能优化或 Bug 修复后，主动触发本技能进行编译打包与本地安装生效。
- **用户显式指令**：当用户下达类似“构建”、“安装到 antigravity”、“重新发布”、“package”、“打包插件”、“写入skill”、“更新插件”等指令时立即执行。
- **本地调试验证**：开发过程中需要快速验证新功能在真实 IDE 界面中的渲染表现或进行远程自动化定位测试时。

**2. 核心执行流程**
1. **自动化前置单测与真实文件回归校验**：
   - 运行 `npm test`，确保 86+ 项用例 100% 通过；
   - 包含针对实际 Klipper 源码（如 `nozzle_manager_wrapper.py` 5600+ 行、`box_nano_wrapper.py` 9500+ 行）的无头符号分析断言，杜绝参数检查与跳转误判。
2. **生产环境编译**：调用 `npm run compile`（执行 `node esbuild.js --production`），输出无依赖高性能 JS bundle。
3. **标准 VSIX 封包**：调用 `npx --yes @vscode/vsce package --no-dependencies`，打出最新版本 `.vsix` 文件。
4. **实时 Antigravity IDE 窗口 IPC 直连热部署**：
   - 自动扫描并锁定运行中的 `/run/user/1000/vscode-ipc-*.sock` 套接字；
   - 注入 `VSCODE_IPC_HOOK_CLI` 环境变量，调用 `/home/zxf/.local/bin/antigravity-ide --install-extension <vsix> --force`，使正在使用的 Antigravity IDE 窗口即时无感热重载生效。
5. **多 IDE 目录分发与 Windows 桌面同步**：
   - 自动同步至 WSL 4 大服务目录：`~/.antigravity-ide-server/extensions/`、`~/.antigravity-server/extensions/`、`~/.vscode-server/extensions/`、`~/.cursor-server/extensions/`；
   - 自动同步至 Windows 3 大客户端目录：`/mnt/c/Users/sageb/.antigravity-ide/extensions/` 等；
   - 自动复制最新 `.vsix` 到 Windows 桌面（`/mnt/c/Users/sageb/Desktop/`），方便分发与市场归档。
6. **历史残留清理与环境自愈**：
   - 自动扫描并安全删除旧版本目录（如 `vivian.xf-omninav-1.0.35` 等），防止磁盘残留与扩展加载混乱。

---

# Antigravity IDE 命令行测试与调试指南

当需要直接与当前打开的 Antigravity IDE 实例进行自动化交互或测试时，可直接通过 IPC 管道执行命令：

**1. 探活与状态查询**
```bash
# 获取当前最新 IPC 套接字并查询运行中的 IDE 窗口与进程状态
VSCODE_IPC_HOOK_CLI=$(ls -t /run/user/1000/vscode-ipc-*.sock | head -1) /home/zxf/.local/bin/antigravity-ide --status
```

**2. 控制正在运行的 IDE 自动跳转定位至目标文件与代码行**
```bash
# 激活正在打开的 Antigravity IDE 窗口，并跳转至指定文件与行号
VSCODE_IPC_HOOK_CLI=$(ls -t /run/user/1000/vscode-ipc-*.sock | head -1) \
  /home/zxf/.local/bin/antigravity-ide -r --goto "/home/zxf/cxsw/code/F039/kl_klipper_440x/klippy/extras/nozzle_manager_wrapper.py:3567"
```

**3. 运行项目级真实集成测试**
```bash
# 运行包含真实生产文件无头检查的全量测试套件
cd omninav && npm test
```

---

# 维护说明与软链接源文件映射

根据全局规范要求，Skill 内部脚本采用符号软链接（Symlink）实时同步工作区源文件，切勿使用普通文件覆盖软链接。

**软链接映射关系表**

| Skill 内部路径 | 软链接指向的工作区源文件绝对路径 | 作用说明 |
| :--- | :--- | :--- |
| `scripts/build_and_install.py` | `/home/zxf/workspace/code/agy/guitool/extension/omninav/scripts/build_and_install.py` | 插件自动化编译、集成测试、打包与 IPC 实时热部署脚本 |
| `~/.gemini/config/skills/omninav-build-install/SKILL.md` | `/home/zxf/workspace/code/agy/guitool/extension/omninav/.agents/skills/omninav-build-install/SKILL.md` | 全局技能软链接指向项目级源文档 |

> [!IMPORTANT]
> 如需修改构建、打包或 IPC 通信逻辑，请直接编辑工作区源文件 `/home/zxf/workspace/code/agy/guitool/extension/omninav/scripts/build_and_install.py`，Skill 内部脚本将实时自动同步。

---

# 命令行使用说明

**1. 常用命令**

```bash
# 1. 标准流程：运行测试 -> 编译 -> 打包 -> 自动 IPC 热重载当前 Antigravity IDE 窗口
python3 scripts/build_and_install.py

# 2. 版本号自动 +1（Patch 位自增）并编译安装热重载（最常用推荐）
python3 scripts/build_and_install.py --bump

# 3. 指定版本号并构建安装
python3 scripts/build_and_install.py --set-version 1.0.37

# 4. 跳过单测快速构建安装
python3 scripts/build_and_install.py --skip-test

# 5. 仅将现有的最新 .vsix 安装到当前 Antigravity IDE 窗口（不重新打包）
python3 scripts/build_and_install.py --only-install
```

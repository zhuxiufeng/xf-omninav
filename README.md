# XF OmniNav for VS Code, Cursor & Antigravity IDE

<p align="center">
  <b>The Ultimate PyCharm-Style All-in-One Code Navigation Suite: Resilient Symbol Jump + Class & Method Inheritance Tree Navigation.</b>
</p>

---

## 🌟 Why XF OmniNav?

In VS Code and Cursor, jumping through dynamic code (Python duck-typing, untyped variables, `*args/**kwargs`, dynamic `self.attr`, or overridden methods in subclass hierarchies) often results in frustrating **"No definition found"** dead ends, or jumps to the wrong base class definition instead of the subclass override.

**XF OmniNav** merges two powerhouse extensions into a single, cohesive, ultra-fast navigation engine:
1. **OmniJump Engine**: Intelligent, resilient Go-to-Definition pipeline with subclass override precision navigation, AST fallback, dynamic attribute indexing, and Vim integration.
2. **OmniTree Visualizer**: PyCharm-grade visual inheritance hierarchy with inline/gutter indicators (⬆️ ⬇️ ↕️), 1-click CodeLens, and instant super/sub navigation.

---

## ✨ Key Capabilities

### 1. 🎯 Subclass Override Precision Navigation (子类重写函数精准直跳)
- **`self.` / `this.` Enclosing Scope Awareness**: When clicking a method call inside a subclass (e.g. `self.speak()`), OmniNav automatically detects the enclosing subclass and jumps **directly to the subclass's overridden definition** rather than the abstract base class!
- **`super().` Parent Resolution**: When calling `super().func()`, jumps directly to the parent class implementation.
- **Local Variable Type Inference**: Resolves calls like `d = Dog(); d.speak()` directly to `Dog.speak`.
- **Abstract Method Penetration**: If a base method is abstract (`pass`, `raise NotImplementedError`, interface) and has a concrete implementation in a subclass, OmniNav jumps directly to the concrete subclass implementation.

### 2. 🚀 PyCharm-Level Resilient Jump Pipeline (OmniJump)
- **LSP First (Fast Path)**: Automatically delegates to native language servers (Pyright, Pylance, gopls, vtsls, etc.) when exact type inference is available.
- **AST / Symbol Engine Fallback**: If the LSP returns `No definition found`, OmniNav seamlessly resolves the definition from the in-memory workspace symbol index!
- **Dynamic Instance Attributes**: Indexes `self.attr = ...` inside class methods with automatic `snake_case` <-> `PascalCase` matching (e.g. `self.box_save.box_filament_err` -> `BoxSave.box_filament_err`).
- **In-Document Immediate Fallback**: Guarantees instant 1ms local jumps even for newly edited or unsaved documents.
- **Virtual Environments & Third-Party Packages**: Automatically scans `.venv`, `venv`, `conda`, and `site-packages` for external modules and symbols.
- **File & Module String Navigation**: Click on imported module paths (`from app.services import ...` or `import chelper`) or string file paths (`'templates/index.html'`) to open the target file.

### 3. 🌉 Python CFFI & C/C++ Cross-Language Direct Jump (Python与C源码跨语言直达)
- **Native C/C++ AST Parsing**: High-speed parser supporting GNU/Klipper multi-line signatures, `__visible` functions, `struct`, `typedef`, and `#define` macros across `.c` and `.h` files.
- **Python CFFI Dynamic Call Resolution**: Calls like `ffi_lib.stepcompress_alloc(...)`, `self.ffi_lib.xxx`, and `self._ffi_lib.xxx` jump **directly into the underlying C implementation file (`.c`)** with exact line numbers and **0 popups**!
- **Header vs Implementation Auto-Resolution**: When both `.c` implementations and `.h` prototypes exist, OmniNav automatically prioritizes the `.c` implementation file for instant code exploration.

### 4. 🔍 Zero-Popup Local Scope Variable Resolution (局部变量优先裁决)
- **Enclosing Function Scope Hierarchy**: When clicking a bare variable identifier (e.g. `same_tnn_list`), OmniNav resolves to the enclosing function's parameters, assignments, or loop targets.
- **No Global Name Pollution**: Function-local variables do not leak into workspace symbol tables, guaranteeing zero ambiguous multi-candidate popups.

### 5. 🌲 Class & Method Inheritance Tree Visualization (OmniTree)
- **Visual Indicators (PyCharm Experience)**:
  - ⬆️ **Up Arrow**: The class inherits from a base class, or the method overrides a superclass method.
  - ⬇️ **Down Arrow**: The class is extended by subclasses, or the method is overridden in subclasses.
  - ↕️ **Bidirectional Arrow**: Both conditions apply (intermediate class or overridden method in multi-level hierarchy).
- **1-Click CodeLens Links**: Direct 1-click jump links directly above classes and methods (e.g. `⬆ Animal.speak` or `⬇ Puppy.speak`).
- **Zero Breakpoint Interference**: By default, indicators use `inline` mode next to the line text so your gutter / glyph margin remains 100% clean for setting breakpoints!
- **PyCharm "Implementations" Popup**: If multiple subclasses override the same method, an interactive QuickPick displays candidate implementations with signature and docstring previews.

### 6. ⚡ Vim-Friendly & Zero Shortcut Conflicts
- **Vim Mode Native (`gd`)**: When using the VSCodeVim extension, pressing `gd` in Normal mode directly invokes OmniNav.
- **Mouse (`Ctrl + Left Click`)**: Smooth click-to-jump with zero configuration.
- **PyCharm Alternative (`Ctrl + Alt + B` / `Alt + D`)**: Dedicated keybinding that avoids Vim `<C-b>` (Page Up) conflicts.

---

## ⌨️ Shortcuts & Navigation Cheatsheet

| Action | Shortcut (Win/Linux) | Shortcut (macOS) | Vim Compatible? |
|:---|:---|:---|:---:|
| **Omni Jump to Definition** | `Ctrl + Click` / `F12` | `Cmd + Click` / `F12` | ✅ **Yes** |
| **Vim Go to Definition** | `gd` (Normal mode) | `gd` (Normal mode) | ✅ **Yes** |
| **Quick Jump (Single hand)** | `Alt + D` | `Option + D` | ✅ **Yes** |
| **Jump to Subclass / Impl** | `Ctrl + Alt + B` | `Cmd + Option + B` | ✅ **Yes** |
| **Jump to Superclass / Base**| `Ctrl + U` | `Cmd + U` | ✅ **Yes** |
| **Find All Callers / Usages**| `Shift + Alt + F12` | `Shift + Option + F12` | ✅ **Yes** |
| **Navigate Back** | `Alt + Left` | `Option + Left` | ✅ **Yes** |
| **Navigate Forward** | `Alt + Right` | `Option + Right` | ✅ **Yes** |
| **Rebuild Symbol Index** | `Ctrl + Shift + P` -> `OmniNav: Rebuild Workspace Index` | - | ✅ **Yes** |

---

## ⚙️ Configuration Reference

All settings can be configured in your VS Code / Cursor `settings.json`:

```json
{
  // Visual Indicator Position: "inline" (default, zero breakpoint conflicts), "glyphMargin", or "both"
  "xfOmniNav.gutterPosition": "inline",

  // Enable/disable 1-click CodeLens above classes and methods
  "xfOmniNav.enableCodeLens": true,

  // Fallback to in-memory AST index when LSP returns no definition
  "xfOmniNav.enableAstFallback": true,

  // Enable smart subclass override precision jump
  "xfOmniNav.enableSubclassJump": true,

  // Maximum number of files to index (default: 5000)
  "xfOmniNav.maxIndexedFiles": 5000,

  // File patterns to exclude from symbol indexing
  "xfOmniNav.excludePatterns": [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/__pycache__/**"
  ]
}
```

> **Backward Compatibility**: Existing configuration keys (`xfOmniJump.*`, `xfOmniTree.*`, `inheritanceNavigator.*`) and command IDs continue to be fully supported!

---

## 📦 Supported Languages

- **Python** (`.py`, `.pyi`) — *Syntactic AST + Cross-file import & inheritance analyzer*
- **TypeScript & JavaScript** (`.ts`, `.tsx`, `.js`, `.jsx`)
- **C & C++** (`.c`, `.cpp`, `.h`, `.hpp`)
- **Go** (`.go`)
- **Rust** (`.rs`)
- **Java** (`.java`)
- **C#** (`.cs`)
- **PHP** (`.php`)

---

## 📄 License

MIT © xf

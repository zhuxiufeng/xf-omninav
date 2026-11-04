#!/usr/bin/env python3
"""
Automated Build & Install Script for XF OmniNav (and VS Code / Antigravity IDE extensions).
1. Runs pre-check unit tests (npm test)
2. Compiles production bundle with esbuild (npm run compile)
3. Packages into .vsix via @vscode/vsce
4. Automatically hot-installs into:
   - Antigravity IDE (WSL): ~/.antigravity-ide-server/extensions/
   - Antigravity Server (WSL): ~/.antigravity-server/extensions/
   - VS Code (WSL): ~/.vscode-server/extensions/
   - Windows VS Code (if code CLI is available)
5. Automatically purges old versions to avoid zombie directory conflicts.
"""

import os
import sys
import json
import shutil
import zipfile
import argparse
import subprocess
from pathlib import Path


def log(msg: str, level: str = "INFO"):
    prefix = {
        "INFO": "\033[32m[INFO]\033[0m",
        "WARN": "\033[33m[WARN]\033[0m",
        "ERROR": "\033[31m[ERROR]\033[0m",
        "DONE": "\033[36m[DONE]\033[0m",
    }.get(level, f"[{level}]")
    print(f"{prefix} {msg}")


def find_extension_root() -> Path:
    """Locate extension workspace root containing package.json."""
    current = Path(__file__).resolve().parent
    while current != current.parent:
        if (current / "package.json").is_file():
            return current
        current = current.parent
    raise FileNotFoundError("Could not find package.json in parent directories.")


def bump_patch_version(pkg_path: Path) -> str:
    with open(pkg_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    cur_version = data.get("version", "1.0.0")
    parts = cur_version.split(".")
    if len(parts) == 3 and parts[2].isdigit():
        parts[2] = str(int(parts[2]) + 1)
        new_version = ".".join(parts)
    else:
        new_version = f"{cur_version}.1"

    data["version"] = new_version
    with open(pkg_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    log(f"Bumped version from {cur_version} -> {new_version}", "INFO")
    return new_version


def run_command(cmd: list[str], cwd: Path, desc: str):
    log(f"Executing: {desc} ({' '.join(cmd)})", "INFO")
    res = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if res.returncode != 0:
        log(f"{desc} failed with exit code {res.returncode}:\n{res.stderr or res.stdout}", "ERROR")
        sys.exit(res.returncode)
    return res.stdout


def install_vsix_to_dir(vsix_path: Path, target_dir: Path, ext_id: str, version: str):
    """Directly unzips VSIX into the target extension directory."""
    if not target_dir.parent.is_dir():
        return False

    os.makedirs(target_dir, exist_ok=True)
    ext_folder_name = f"{ext_id}-{version}"
    dest_path = target_dir / ext_folder_name

    # 1. Clean up older versions of this extension in target directory
    for item in target_dir.glob(f"{ext_id}-*"):
        if item.is_dir() and item.name != ext_folder_name:
            try:
                shutil.rmtree(item)
                log(f"Cleaned up obsolete extension version: {item.name} in {target_dir.name}", "INFO")
            except Exception as e:
                log(f"Failed to remove {item}: {e}", "WARN")

    # 2. Extract into dest_path
    if dest_path.is_dir():
        shutil.rmtree(dest_path)
    os.makedirs(dest_path, exist_ok=True)

    with zipfile.ZipFile(vsix_path, "r") as zf:
        for member in zf.infolist():
            filename = member.filename
            if filename == "extension.vsixmanifest":
                with zf.open(member) as src, open(dest_path / ".vsixmanifest", "wb") as dst:
                    dst.write(src.read())
            elif filename.startswith("extension/"):
                rel_path = filename[len("extension/"):]
                if not rel_path:
                    continue
                out_file = dest_path / rel_path
                if member.is_dir() or filename.endswith("/"):
                    os.makedirs(out_file, exist_ok=True)
                else:
                    os.makedirs(out_file.parent, exist_ok=True)
                    with zf.open(member) as src, open(out_file, "wb") as dst:
                        dst.write(src.read())

    log(f"Extracted and installed {ext_folder_name} -> {dest_path}", "DONE")
    return True


def main():
    parser = argparse.ArgumentParser(description="Build and install VS Code / Antigravity IDE extension.")
    parser.add_argument("--bump", action="store_true", help="Bump patch version in package.json before building")
    parser.add_argument("--set-version", type=str, help="Explicitly set version string")
    parser.add_argument("--skip-test", action="store_true", help="Skip running npm test")
    parser.add_argument("--only-install", action="store_true", help="Skip build & package, only install latest .vsix")
    args = parser.parse_args()

    root = find_extension_root()
    pkg_file = root / "package.json"

    with open(pkg_file, "r", encoding="utf-8") as f:
        pkg_data = json.load(f)

    if args.set_version:
        pkg_data["version"] = args.set_version
        with open(pkg_file, "w", encoding="utf-8") as f:
            json.dump(pkg_data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        log(f"Set version to {args.set_version}", "INFO")
    elif args.bump:
        bump_patch_version(pkg_file)
        with open(pkg_file, "r", encoding="utf-8") as f:
            pkg_data = json.load(f)

    name = pkg_data.get("name", "extension")
    publisher = pkg_data.get("publisher", "unknown").lower()
    version = pkg_data.get("version", "1.0.0")
    ext_id = f"{publisher}.{name}"
    vsix_name = f"{name}-{version}.vsix"
    vsix_path = root / vsix_name

    if not args.only_install:
        # Step 1: Tests
        if not args.skip_test:
            log("Running test suite...", "INFO")
            run_command(["npm", "test"], root, "Test Suite")

        # Step 2: Compile
        log("Compiling production bundle via esbuild...", "INFO")
        run_command(["npm", "run", "compile"], root, "Esbuild Compile")

        # Step 3: Package VSIX
        log(f"Packaging {vsix_name} via vsce...", "INFO")
        run_command(["npx", "--yes", "@vscode/vsce", "package", "--no-dependencies"], root, "VSIX Package")

    if not vsix_path.is_file():
        # Fallback to search for latest vsix
        existing_vsix = sorted(root.glob(f"{name}-*.vsix"), key=os.path.getmtime, reverse=True)
        if existing_vsix:
            vsix_path = existing_vsix[0]
            log(f"Using latest found VSIX: {vsix_path.name}", "INFO")
        else:
            log(f"VSIX file not found at {vsix_path}", "ERROR")
            sys.exit(1)

    log(f"Installing {vsix_path.name} to target IDEs...", "INFO")

    # Target directories to install (both WSL remote server and Windows client roots)
    home = Path.home()
    target_dirs = [
        home / ".antigravity-ide-server" / "extensions",
        home / ".antigravity-server" / "extensions",
        home / ".vscode-server" / "extensions",
        home / ".cursor-server" / "extensions",
        Path("/mnt/c/Users/sageb/.antigravity-ide/extensions"),
        Path("/mnt/c/Users/sageb/.vscode/extensions"),
        Path("/mnt/c/Users/sageb/.cursor/extensions"),
    ]

    installed_count = 0
    for t_dir in target_dirs:
        if t_dir.exists():
            if install_vsix_to_dir(vsix_path, t_dir, ext_id, version):
                installed_count += 1

    # Optional: invoke code CLI if available
    code_bins = [
        "/mnt/c/Users/sageb/AppData/Local/Programs/Microsoft VS Code/bin/code",
        "code",
    ]
    for bin_path in code_bins:
        code_path = shutil.which(bin_path)
        if code_path:
            try:
                subprocess.run(
                    [code_path, "--install-extension", str(vsix_path), "--force"],
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                log(f"Installed via '{code_path} --install-extension'", "DONE")
                break
            except Exception as e:
                log(f"Code CLI install notice: {e}", "WARN")

    log(f"Successfully installed {ext_id} v{version} to {installed_count} IDE extension root(s).", "DONE")
    log("Please press 'F1' -> 'Developer: Reload Window' in your editor to apply changes.", "INFO")

    # Copy to Windows Desktop for easy marketplace web upload
    desktop_dir = Path("/mnt/c/Users/sageb/Desktop")
    if desktop_dir.is_dir():
        try:
            shutil.copy2(vsix_path, desktop_dir / vsix_path.name)
            log(f"Copied {vsix_path.name} -> Windows Desktop ({desktop_dir})", "DONE")
        except Exception as e:
            log(f"Notice copying to desktop: {e}", "WARN")


if __name__ == "__main__":
    main()

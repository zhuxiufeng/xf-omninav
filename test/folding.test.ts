import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PythonBranchFoldingProvider } from '../src/folding/pythonFoldingProvider';
import { ShellBranchFoldingProvider } from '../src/folding/shellFoldingProvider';
import { CppMacroFoldingProvider } from '../src/folding/cppMacroFoldingProvider';
import { SwitchCaseFoldingProvider } from '../src/folding/switchCaseFoldingProvider';
import { RustBranchFoldingProvider } from '../src/folding/rustFoldingProvider';
import { FoldingRangeKind } from './vscode-mock';

describe('PythonBranchFoldingProvider tests', () => {
  it('should fold if, elif, and else branches independently (PyCharm style)', () => {
    const code = [
      'if condition_a:', // Line 0
      '    do_action_1()', // Line 1
      '    do_action_2()', // Line 2
      'elif condition_b:', // Line 3
      '    do_action_3()', // Line 4
      'else:', // Line 5
      '    do_action_4()', // Line 6
      '    do_action_5()', // Line 7
    ].join('\n');

    const ranges = PythonBranchFoldingProvider.computeFoldingRanges(code);

    // Range for `if`: Line 0 to Line 2
    const ifRange = ranges.find((r) => r.start === 0);
    assert.ok(ifRange, 'Should find folding range for if');
    assert.strictEqual(ifRange.end, 2, 'if branch should fold until line before elif');

    // Range for `elif`: Line 3 to Line 4
    const elifRange = ranges.find((r) => r.start === 3);
    assert.ok(elifRange, 'Should find folding range for elif');
    assert.strictEqual(elifRange.end, 4, 'elif branch should fold until line before else');

    // Range for `else`: Line 5 to Line 7
    const elseRange = ranges.find((r) => r.start === 5);
    assert.ok(elseRange, 'Should find folding range for else');
    assert.strictEqual(elseRange.end, 7, 'else branch should fold to end of block');
  });

  it('should fold real-world Klipper multi-branch if-elif chain independently', () => {
    const code = [
      "Tn = 'T' + str(addr)", // 0
      'if part == "vender" or part == "remain_len":', // 1
      '    if num not in num_map:', // 2
      '        logging.warning("change data[%s], but do not has num" % part)', // 3
      '        return None', // 4
      '    logging.info("Tn_data[%s][%s][%s]: %s" % (Tn, part, num_map[num], self.Tn_data[Tn][part][num_map[num]]))', // 5
      '    return self.Tn_data[Tn][part][num_map[num]]', // 6
      'elif part == "color_value" or part == "material_type" or part == "change_color_num" or part == "xyz_offset":', // 7
      '    if num not in num_map:', // 8
      '        logging.warning("change data[%s], but do not has num" % part)', // 9
      '        return None', // 10
      '    logging.info("Tn_data[%s][%s][%s]: %s" % (Tn, part, num_map[num], self.Tn_data[Tn][part][num_map[num]]))', // 11
      '    return self.Tn_data[Tn][part][num_map[num]]', // 12
      'elif part == "gear_state" and num in num_map:', // 13
      '    logging.debug("Tn_data[%s][%s][%s]: %s" % (Tn, part, num_map[num], self.Tn_data[Tn][part][num_map[num]]))', // 14
      '    return self.Tn_data[Tn][part][num_map[num]]', // 15
      'if part != "state":', // 16
      '    return None', // 17
    ].join('\n');

    const ranges = PythonBranchFoldingProvider.computeFoldingRanges(code);
    const ifRange = ranges.find((r) => r.start === 1);
    assert.ok(ifRange, 'Should find folding range for first if');
    assert.strictEqual(ifRange.end, 6, 'First if should end right before elif at line 7');

    const elif1Range = ranges.find((r) => r.start === 7);
    assert.ok(elif1Range, 'Should find folding range for first elif');
    assert.strictEqual(elif1Range.end, 12, 'First elif should end right before second elif at line 13');

    const elif2Range = ranges.find((r) => r.start === 13);
    assert.ok(elif2Range, 'Should find folding range for second elif');
    assert.strictEqual(elif2Range.end, 15, 'Second elif should end right before next if at line 16');
  });

  it('should fold nested if-else structures without cross-branch contamination', () => {
    const code = [
      'if outer_cond:', // 0
      '    do_outer_1()', // 1
      '    if inner_cond:', // 2
      '        do_inner_1()', // 3
      '    else:', // 4
      '        do_inner_2()', // 5
      'else:', // 6
      '    do_outer_2()', // 7
    ].join('\n');

    const ranges = PythonBranchFoldingProvider.computeFoldingRanges(code);

    const outerIf = ranges.find((r) => r.start === 0);
    assert.ok(outerIf);
    assert.strictEqual(outerIf.end, 5, 'outer if should fold until line before outer else');

    const innerIf = ranges.find((r) => r.start === 2);
    assert.ok(innerIf);
    assert.strictEqual(innerIf.end, 3, 'inner if should fold until line before inner else');

    const innerElse = ranges.find((r) => r.start === 4);
    assert.ok(innerElse);
    assert.strictEqual(innerElse.end, 5, 'inner else should fold to line 5');

    const outerElse = ranges.find((r) => r.start === 6);
    assert.ok(outerElse);
    assert.strictEqual(outerElse.end, 7, 'outer else should fold to line 7');
  });

  it('should fold try, except, else, and finally independently', () => {
    const code = [
      'try:', // 0
      '    risk_call()', // 1
      'except ValueError:', // 2
      '    handle_val()', // 3
      'except Exception:', // 4
      '    handle_gen()', // 5
      'else:', // 6
      '    no_error()', // 7
      'finally:', // 8
      '    cleanup()', // 9
    ].join('\n');

    const ranges = PythonBranchFoldingProvider.computeFoldingRanges(code);

    const tryRange = ranges.find((r) => r.start === 0);
    assert.ok(tryRange);
    assert.strictEqual(tryRange.end, 1);

    const ex1 = ranges.find((r) => r.start === 2);
    assert.ok(ex1);
    assert.strictEqual(ex1.end, 3);

    const ex2 = ranges.find((r) => r.start === 4);
    assert.ok(ex2);
    assert.strictEqual(ex2.end, 5);

    const elseRange = ranges.find((r) => r.start === 6);
    assert.ok(elseRange);
    assert.strictEqual(elseRange.end, 7);

    const finRange = ranges.find((r) => r.start === 8);
    assert.ok(finRange);
    assert.strictEqual(finRange.end, 9);
  });

  it('should handle multiline parenthesized compound statement headers', () => {
    const code = [
      'if (', // 0
      '    flag_a and', // 1
      '    flag_b', // 2
      '):', // 3
      '    do_something()', // 4
      '    do_more()', // 5
      'else:', // 6
      '    fallback()', // 7
    ].join('\n');

    const ranges = PythonBranchFoldingProvider.computeFoldingRanges(code);

    const ifRange = ranges.find((r) => r.start === 0);
    assert.ok(ifRange, 'Should start at line 0 where if begins');
    assert.strictEqual(ifRange.end, 5, 'Should end at line 5 before else:');

    const elseRange = ranges.find((r) => r.start === 6);
    assert.ok(elseRange);
    assert.strictEqual(elseRange.end, 7);
  });

  it('should identify imports and docstrings with proper kinds', () => {
    const code = [
      'import os', // 0
      'import sys', // 1
      'from pathlib import Path', // 2
      '', // 3
      'def foo():', // 4
      '    """', // 5
      '    Docstring text', // 6
      '    """', // 7
      '    pass', // 8
    ].join('\n');

    const ranges = PythonBranchFoldingProvider.computeFoldingRanges(code);

    const importRange = ranges.find((r) => r.start === 0 && r.kind === FoldingRangeKind.Imports);
    assert.ok(importRange, 'Should find imports range');
    assert.strictEqual(importRange.end, 2);

    const docstringRange = ranges.find((r) => r.start === 5 && r.kind === FoldingRangeKind.Comment);
    assert.ok(docstringRange, 'Should find docstring range');
    assert.strictEqual(docstringRange.end, 7);

    const funcRange = ranges.find((r) => r.start === 4);
    assert.ok(funcRange, 'Should find def range');
    assert.strictEqual(funcRange.end, 8);
  });

  it('should handle Python backslash line continuations in if and elif headers', () => {
    const code = [
      'if self.extrude_process_ret_state == "EXTRUDE_ERR6" or \\', // 0
      '    (self.extrude_process_ret_state == "EXTRUDE_ERR5" and cond1) or \\', // 1
      '    (self.extrude_process_ret_state == "EXTRUDE_ERR8" and cond2):', // 2
      '    if retry[sensor] == 0:', // 3
      '        ret = self.action(retry)', // 4
      '        return ret', // 5
      '    elif retry[sensor] == 1 and \\', // 6
      '        retry[second] == 0:', // 7
      '        ret = self.action_second(retry)', // 8
      '        return ret', // 9
      '    elif retry[second] == 1:', // 10
      '        error()', // 11
      '        return False', // 12
    ].join('\n');

    const ranges = PythonBranchFoldingProvider.computeFoldingRanges(code);

    // Outer if: line 0 -> 12
    const outerIf = ranges.find((r) => r.start === 0);
    assert.ok(outerIf, 'Should find outer if starting at line 0');
    assert.strictEqual(outerIf.end, 12, 'Outer if should fold entire compound body');

    // First inner if: line 3 -> 5
    const innerIf = ranges.find((r) => r.start === 3);
    assert.ok(innerIf, 'Should find first inner if at line 3');
    assert.strictEqual(innerIf.end, 5, 'First inner if should fold lines 3-5 before elif');

    // First elif (with backslash): line 6 -> 9
    const elif1 = ranges.find((r) => r.start === 6);
    assert.ok(elif1, 'Should find elif at line 6');
    assert.strictEqual(elif1.end, 9, 'Elif 1 should fold lines 6-9 before elif 2');

    // Second elif: line 10 -> 12
    const elif2 = ranges.find((r) => r.start === 10);
    assert.ok(elif2, 'Should find elif at line 10');
    assert.strictEqual(elif2.end, 12, 'Elif 2 should fold lines 10-12');
  });

  it('should fold multiline dictionary and list bracket structures independently', () => {
    const code = [
      'data = {', // 0
      '    "a": 1,', // 1
      '    "b": [', // 2
      '        10,', // 3
      '        20,', // 4
      '    ],', // 5
      '}', // 6
    ].join('\n');

    const ranges = PythonBranchFoldingProvider.computeFoldingRanges(code);

    const dictRange = ranges.find((r) => r.start === 0);
    assert.ok(dictRange, 'Should find range for dict starting at line 0');
    assert.strictEqual(dictRange.end, 6, 'Dict range should end at line 6');

    const listRange = ranges.find((r) => r.start === 2);
    assert.ok(listRange, 'Should find range for list starting at line 2');
    assert.strictEqual(listRange.end, 5, 'List range should end at line 5');
  });
});

describe('ShellBranchFoldingProvider tests', () => {
  it('should fold if, elif, and else independently in shell scripts', () => {
    const code = [
      'if [ "$1" = "start" ]; then', // 0
      '    echo "Starting..."', // 1
      '    run_daemon', // 2
      'elif [ "$1" = "stop" ]; then', // 3
      '    echo "Stopping..."', // 4
      '    kill_daemon', // 5
      'else', // 6
      '    echo "Usage: $0 start|stop"', // 7
      'fi', // 8
    ].join('\n');

    const ranges = ShellBranchFoldingProvider.computeFoldingRanges(code);

    const ifRange = ranges.find((r) => r.start === 0);
    assert.ok(ifRange, 'Should find if range');
    assert.strictEqual(ifRange.end, 2, 'if branch should fold until line before elif');

    const elifRange = ranges.find((r) => r.start === 3);
    assert.ok(elifRange, 'Should find elif range');
    assert.strictEqual(elifRange.end, 5, 'elif branch should fold until line before else');

    const elseRange = ranges.find((r) => r.start === 6);
    assert.ok(elseRange, 'Should find else range');
    assert.strictEqual(elseRange.end, 8, 'else branch should fold to fi');
  });

  it('should ignore shell keywords inside quotes and comments', () => {
    const code = [
      '# if this is a comment it should be ignored', // 0
      'echo "if inside quotes should be ignored"', // 1
      'if [ -f "/tmp/lock" ]; then', // 2
      '    echo \'else inside quotes should be ignored\'', // 3
      'fi', // 4
    ].join('\n');

    const ranges = ShellBranchFoldingProvider.computeFoldingRanges(code);

    const ifRange = ranges.find((r) => r.start === 2);
    assert.ok(ifRange, 'Should find real if at line 2');
    assert.strictEqual(ifRange.end, 4);
    assert.strictEqual(ranges.filter((r) => !r.kind).length, 1, 'Only one code folding range should exist');
  });

  it('should fold case statements correctly', () => {
    const code = [
      'case "$action" in', // 0
      '    start)', // 1
      '        do_start', // 2
      '        ;;', // 3
      '    stop)', // 4
      '        do_stop', // 5
      '        ;;', // 6
      'esac', // 7
    ].join('\n');

    const ranges = ShellBranchFoldingProvider.computeFoldingRanges(code);
    const caseRange = ranges.find((r) => r.start === 0);
    assert.ok(caseRange);
    assert.strictEqual(caseRange.end, 7);
  });
});

describe('CppMacroFoldingProvider tests', () => {
  it('should fold #if, #elif, and #else branches independently in C/C++', () => {
    const code = [
      '#if defined(CONFIG_MCU_STM32)', // 0
      '    init_stm32();', // 1
      '    setup_clock();', // 2
      '#elif defined(CONFIG_MCU_AVR)', // 3
      '    init_avr();', // 4
      '#else', // 5
      '    #error "Unsupported MCU"', // 6
      '#endif', // 7
    ].join('\n');

    const ranges = CppMacroFoldingProvider.computeFoldingRanges(code);

    const ifRange = ranges.find((r) => r.start === 0);
    assert.ok(ifRange, 'Should find #if at line 0');
    assert.strictEqual(ifRange.end, 2, '#if should fold lines 0-2 before #elif');

    const elifRange = ranges.find((r) => r.start === 3);
    assert.ok(elifRange, 'Should find #elif at line 3');
    assert.strictEqual(elifRange.end, 4, '#elif should fold lines 3-4 before #else');

    const elseRange = ranges.find((r) => r.start === 5);
    assert.ok(elseRange, 'Should find #else at line 5');
    assert.strictEqual(elseRange.end, 7, '#else should fold lines 5-7 to #endif');
  });

  it('should handle multi-line macro directives with backslash continuation', () => {
    const code = [
      '#if defined(MCU_ESP32) && \\', // 0
      '    defined(ENABLE_WIFI)', // 1
      '    setup_wifi();', // 2
      '#elif defined(MCU_ESP32) && \\', // 3
      '      defined(ENABLE_BLE)', // 4
      '    setup_ble();', // 5
      '#endif', // 6
    ].join('\n');

    const ranges = CppMacroFoldingProvider.computeFoldingRanges(code);

    const ifRange = ranges.find((r) => r.start === 0);
    assert.ok(ifRange, 'Should find #if starting at line 0');
    assert.strictEqual(ifRange.end, 2, '#if should fold until line 2 before #elif');

    const elifRange = ranges.find((r) => r.start === 3);
    assert.ok(elifRange, 'Should find #elif starting at line 3');
    assert.strictEqual(elifRange.end, 6, '#elif should fold until line 6 to #endif');
  });

  it('should handle nested macro conditionals correctly', () => {
    const code = [
      '#if defined(DEBUG)', // 0
      '    #ifdef VERBOSE', // 1
      '        log_verbose();', // 2
      '    #else', // 3
      '        log_normal();', // 4
      '    #endif', // 5
      '#endif', // 6
    ].join('\n');

    const ranges = CppMacroFoldingProvider.computeFoldingRanges(code);

    const outerIf = ranges.find((r) => r.start === 0);
    assert.ok(outerIf);
    assert.strictEqual(outerIf.end, 6);

    const innerIf = ranges.find((r) => r.start === 1);
    assert.ok(innerIf);
    assert.strictEqual(innerIf.end, 2);

    const innerElse = ranges.find((r) => r.start === 3);
    assert.ok(innerElse);
    assert.strictEqual(innerElse.end, 5);
  });
});

describe('SwitchCaseFoldingProvider tests', () => {
  it('should fold TypeScript/JavaScript switch cases independently without braces', () => {
    const code = [
      'function handle(action) {', // 0
      '    switch (action.type) {', // 1
      '        case "INIT":', // 2
      '            initVars();', // 3
      '            setupHandler();', // 4
      '            break;', // 5
      '        case "UPDATE":', // 6
      '            applyUpdate();', // 7
      '            break;', // 8
      '        default:', // 9
      '            handleFallback();', // 10
      '    }', // 11
      '}', // 12
    ].join('\n');

    const ranges = SwitchCaseFoldingProvider.computeFoldingRanges(code);

    const case1 = ranges.find((r) => r.start === 2);
    assert.ok(case1, 'Should find case INIT');
    assert.strictEqual(case1.end, 5, 'case INIT should fold lines 2-5 before case UPDATE');

    const case2 = ranges.find((r) => r.start === 6);
    assert.ok(case2, 'Should find case UPDATE');
    assert.strictEqual(case2.end, 8, 'case UPDATE should fold lines 6-8 before default');

    const defCase = ranges.find((r) => r.start === 9);
    assert.ok(defCase, 'Should find default case');
    assert.strictEqual(defCase.end, 10, 'default case should fold lines 9-10 before closing brace');
  });

  it('should fold Go switch and select cases independently', () => {
    const code = [
      'func handleEvents(ch chan int) {', // 0
      '    select {', // 1
      '    case msg := <-ch:', // 2
      '        process(msg)', // 3
      '        log()', // 4
      '    case <-time.After(time.Second):', // 5
      '        timeout()', // 6
      '    default:', // 7
      '        idle()', // 8
      '    }', // 9
      '}', // 10
    ].join('\n');

    const ranges = SwitchCaseFoldingProvider.computeFoldingRanges(code);

    const case1 = ranges.find((r) => r.start === 2);
    assert.ok(case1, 'Should find select case 1');
    assert.strictEqual(case1.end, 4);

    const case2 = ranges.find((r) => r.start === 5);
    assert.ok(case2, 'Should find select case 2');
    assert.strictEqual(case2.end, 6);

    const defCase = ranges.find((r) => r.start === 7);
    assert.ok(defCase, 'Should find select default');
    assert.strictEqual(defCase.end, 8);
  });
});

describe('RustBranchFoldingProvider tests', () => {
  it('should fold Rust match arms independently', () => {
    const code = [
      'fn process(event: Event) {', // 0
      '    match event {', // 1
      '        Event::Start(id) => {', // 2
      '            init_session(id);', // 3
      '            start_loop();', // 4
      '        }', // 5
      '        Event::Stop => {', // 6
      '            cleanup();', // 7
      '        }', // 8
      '        _ => (),', // 9
      '    }', // 10
      '}', // 11
    ].join('\n');

    const ranges = RustBranchFoldingProvider.computeFoldingRanges(code);

    const arm1 = ranges.find((r) => r.start === 2);
    assert.ok(arm1, 'Should find match arm 1');
    assert.strictEqual(arm1.end, 5, 'Arm 1 should fold until line before Arm 2');

    const arm2 = ranges.find((r) => r.start === 6);
    assert.ok(arm2, 'Should find match arm 2');
    assert.strictEqual(arm2.end, 8, 'Arm 2 should fold until line before _ =>');
  });

  it('should fold consecutive Rust attribute macros into a single block', () => {
    const code = [
      '#[derive(Debug, Clone, PartialEq, Eq)]', // 0
      '#[serde(rename_all = "camelCase")]', // 1
      '#[repr(C)]', // 2
      'pub struct MyMessage {', // 3
      '    pub id: u64,', // 4
      '}', // 5
    ].join('\n');

    const ranges = RustBranchFoldingProvider.computeFoldingRanges(code);

    const attrRange = ranges.find((r) => r.start === 0);
    assert.ok(attrRange, 'Should find attribute macro folding range');
    assert.strictEqual(attrRange.end, 2, 'Attributes should fold from line 0 to line 2');
  });

  it('should scan lines zero-allocation with FastLineScanner accurately handling LF and CRLF', () => {
    const { FastLineScanner } = require('../src/folding/pythonFoldingProvider');
    const text = 'line 1\r\n   \t  \r\nline 3\n\nline 5';
    const scanner = new FastLineScanner(text);

    assert.strictEqual(scanner.lineCount, 5);
    assert.strictEqual(scanner.getLine(0), 'line 1');
    assert.strictEqual(scanner.isWhitespace(0), false);

    assert.strictEqual(scanner.getLine(1), '   \t  ');
    assert.strictEqual(scanner.isWhitespace(1), true);

    assert.strictEqual(scanner.getLine(2), 'line 3');
    assert.strictEqual(scanner.isWhitespace(2), false);

    assert.strictEqual(scanner.getLine(3), '');
    assert.strictEqual(scanner.isWhitespace(3), true);

    assert.strictEqual(scanner.getLine(4), 'line 5');
    assert.strictEqual(scanner.isWhitespace(4), false);
  });
});

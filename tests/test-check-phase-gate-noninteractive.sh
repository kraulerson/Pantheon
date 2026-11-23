#!/usr/bin/env bash
# BUGS #58 — scripts/check-phase-gate.sh on a machine with no keyboard (a CI runner, a hook), and at a terminal
# where nobody answers.
#
# Copies the tracked governance files into a throwaway folder, swaps in a stub tool resolver that reports a
# missing required tool whose install command would leave a marker file, and runs the real script. docker, uvx
# and claude are stubs that only record what they were asked, so a regression cannot touch the real ones.
# Nothing is installed and nothing outside the throwaway folder is written.
#
# The exit-0 cases need this project's own governance files to be consistent, as CI does.
#
# Usage: bash tests/test-check-phase-gate-noninteractive.sh        exit 0 = every case passed
# Runs on /bin/bash 3.2.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/phase-gate-test.XXXXXX")" || exit 1
[ -n "$WORK" ] && [ -d "$WORK" ] || exit 1
trap 'rm -rf "$WORK"' EXIT
fails=0

# One fresh copy of the tracked tree (no services, no prototypes) per case, from the working tree, so the script
# under test is the one on disk.
fixture() {
  local dir="$WORK/$1" tool
  mkdir -p "$dir/bin"
  (cd "$ROOT" && git ls-files -z -- . ':(exclude)services' ':(exclude)peta-eval' ':(exclude)prototypes' | tar --null -T - -cf - 2>/dev/null) | tar -xf - -C "$dir"
  for tool in docker uvx claude; do
    printf '%s\n' '#!/usr/bin/env bash' "echo \"$tool \$*\" >> \"\$(dirname \"\$0\")/tools.log\"" 'exit 0' > "$dir/bin/$tool"
    chmod +x "$dir/bin/$tool"
  done
  echo "$dir"
}

# The stub resolver: $2 is the JSON it prints, whatever it is asked.
stub_resolver() {
  printf '%s\n' '#!/usr/bin/env bash' "cat <<'JSON'" "$2" 'JSON' > "$1/scripts/resolve-tools.sh"
  chmod +x "$1/scripts/resolve-tools.sh"
}

missing_tool() {
  echo "{\"auto_install\":[{\"name\":\"$2\",\"required\":true,\"description\":\"stub tool\",\"install_command\":\"touch '$1/INSTALLED'\"}],\"manual_install\":[]}"
}

# run <dir> [VAR=value ...]: no terminal, input at end of file. Output lands in <dir>/out.txt, the exit code in $rc.
run() {
  local dir="$1"; shift
  (cd "$dir" && env -i HOME="$dir" PATH="$dir/bin:$PATH" "$@" bash scripts/check-phase-gate.sh < /dev/null > out.txt 2>&1)
  rc=$?
}

# run_pty <dir> [VAR=value ...]: the same, but with a terminal on standard input whose input ends unanswered.
# Returns 1 when this machine's script(1) cannot be driven (the case is then skipped, not failed).
PTY=none
if script -q /dev/null true > /dev/null 2>&1 < /dev/null; then PTY=bsd; fi
if script --version 2> /dev/null | grep -q util-linux; then PTY=linux; fi
run_pty() {
  local dir="$1"; shift
  case "$PTY" in
    bsd) (cd "$dir" && env -i HOME="$dir" PATH="$dir/bin:$PATH" "$@" script -q /dev/null bash scripts/check-phase-gate.sh < /dev/null > out.txt 2>&1) ;;
    linux) (cd "$dir" && env -i HOME="$dir" PATH="$dir/bin:$PATH" "$@" script -qec "bash scripts/check-phase-gate.sh" /dev/null < /dev/null > out.txt 2>&1) ;;
    *) return 1 ;;
  esac
  rc=$?
}

check() {
  if eval "$2"; then
    echo "  ok    $1"
  else
    echo "  FAIL  $1"
    fails=$((fails + 1))
  fi
}

echo "T1 on a CI runner a missing required tool is listed, not installed and not counted"
d="$(fixture t1)"; stub_resolver "$d" "$(missing_tool "$d" FakeTool)"; run "$d" CI=true
check "exit 0 (was 1)" '[ "$rc" -eq 0 ]'
check "the missing tool is still named" 'grep -q "FakeTool" "$d/out.txt"'
check "the output says why it is not counted" 'grep -q "CI runner (CI=true)" "$d/out.txt"'
check "the install command did not run" '[ ! -e "$d/INSTALLED" ]'
check "the other checks ran to the end" 'grep -q "Phase gates consistent" "$d/out.txt"'

echo "T2 with no keyboard and no CI variable (a hook, a script) it still blocks, and installs nothing"
d="$(fixture t2)"; stub_resolver "$d" "$(missing_tool "$d" FakeTool)"; run "$d"
check "exit 1" '[ "$rc" -eq 1 ]'
check "the missing tool is named" 'grep -q "FakeTool" "$d/out.txt"'
check "it says the question was skipped" 'grep -q "skipping the question" "$d/out.txt"'
check "it reports a blocking inconsistency" 'grep -q "blocking" "$d/out.txt"'
check "the install command did not run" '[ ! -e "$d/INSTALLED" ]'

echo "T3 on a CI runner a missing Qdrant MCP reaches its question, skips it and starts nothing"
d="$(fixture t3)"; stub_resolver "$d" "$(missing_tool "$d" "Qdrant MCP")"; run "$d" CI=true
check "exit 0" '[ "$rc" -eq 0 ]'
check "the Qdrant question was reached and skipped" 'grep -q "skipping the question \"Start Qdrant" "$d/out.txt"'
check "docker was not asked to run or start anything" '! grep -q -E "^docker (run|start) " "$d/bin/tools.log" 2>/dev/null'
check "claude and uvx were not called" '! grep -q -E "^(claude|uvx) " "$d/bin/tools.log" 2>/dev/null'
check "the install command did not run" '[ ! -e "$d/INSTALLED" ]'

echo "T4 on a workstation with nothing missing the check passes and the tool section stays silent"
d="$(fixture t4)"; stub_resolver "$d" '{"auto_install":[],"manual_install":[]}'; run "$d"
check "exit 0" '[ "$rc" -eq 0 ]'
check "no tools are listed" '! grep -q "Tools needed" "$d/out.txt"'
check "the checks ran to the end" 'grep -q "Phase gates consistent" "$d/out.txt"'

echo "T5 a CI runner excuses the missing tools only: a real inconsistency still blocks"
d="$(fixture t5)"; stub_resolver "$d" "$(missing_tool "$d" FakeTool)"; mv "$d/PROJECT_BIBLE.md" "$d/PROJECT_BIBLE.away"; run "$d" CI=true
check "exit 1 without the project bible" '[ "$rc" -eq 1 ]'
check "the missing bible is what blocked" 'grep -q "PROJECT_BIBLE.md" "$d/out.txt" && grep -q "blocking" "$d/out.txt"'
check "the tool exemption was reached, so the block is not from the tools" 'grep -q "CI runner (CI=true)" "$d/out.txt"'

echo "T6 CI=false is not a CI runner"
d="$(fixture t6)"; stub_resolver "$d" "$(missing_tool "$d" FakeTool)"; run "$d" CI=false
check "exit 1" '[ "$rc" -eq 1 ]'
check "the tools are counted" '! grep -q "CI runner (CI=true)" "$d/out.txt" && grep -q "blocking" "$d/out.txt"'
check "the install command did not run" '[ ! -e "$d/INSTALLED" ]'

echo "T7 at a terminal where the question gets no answer, nothing is installed"
d="$(fixture t7)"; stub_resolver "$d" "$(missing_tool "$d" FakeTool)"
if run_pty "$d"; then
  check "the question was asked" 'grep -q "Install now" "$d/out.txt"'
  check "the install command did not run" '[ ! -e "$d/INSTALLED" ]'
  check "it still blocks" 'grep -q "blocking" "$d/out.txt"'
else
  echo "  skip  no usable script(1) on this machine"
fi

echo "T8 at a terminal on a CI runner the question is not asked"
d="$(fixture t8)"; stub_resolver "$d" "$(missing_tool "$d" FakeTool)"
if run_pty "$d" CI=true; then
  check "it says the question was skipped" 'grep -q "skipping the question" "$d/out.txt"'
  check "the install command did not run" '[ ! -e "$d/INSTALLED" ]'
  check "the checks ran to the end" 'grep -q "Phase gates consistent" "$d/out.txt"'
else
  echo "  skip  no usable script(1) on this machine"
fi

echo "T9 at a terminal with SOIF_NONINTERACTIVE set the question is not asked, and the tools still count"
d="$(fixture t9)"; stub_resolver "$d" "$(missing_tool "$d" FakeTool)"
if run_pty "$d" SOIF_NONINTERACTIVE=1; then
  check "it says the question was skipped" 'grep -q "skipping the question" "$d/out.txt"'
  check "the install command did not run" '[ ! -e "$d/INSTALLED" ]'
  check "it still blocks" 'grep -q "blocking" "$d/out.txt"'
else
  echo "  skip  no usable script(1) on this machine"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "all cases passed"
else
  echo "$fails check(s) failed"
fi
exit "$fails"

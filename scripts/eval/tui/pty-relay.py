#!/usr/bin/env python3
"""PTY relay for the #1219 TUI calibration driver.

WHY a relay instead of pipes: the TUI under test needs a real controlling
terminal. This repository has no `node-pty` dependency, and adding one is a
lockfile change outside the task, so the available path is the platform's own:
`pty.fork()`, which gives the child a real controlling terminal (a tty-shaped
pipe is not one — the surface under test switches modes on `isatty`).

Transport contract, kept deliberately narrow:

  stdout  ``CHILDPID <pid>\\n`` then the pty master VERBATIM. Nothing else is
          ever interleaved, so the parent can retain the byte stream without
          filtering it.
  stdin   forwarded to the pty master verbatim, EXCEPT control lines. A buffer
          is control only when it (a) contains a newline and (b) its first line
          is exactly a verb. Every control line is written as one small pipe
          write, which POSIX makes atomic below PIPE_BUF, so a control line is
          never split across reads; a stimulus is single-line text and is
          therefore forwarded byte-for-byte, never re-chunked or filtered.
  stderr  the relay's own control channel only (the child's stderr is the pty
          slave, so it lands in the stdout stream). Reporting the child's exit
          here is what makes a clean `/quit` distinguishable from a teardown
          discovery.

Control verbs (one per line, on stdin):

  ``KILL``            SIGKILL the child's whole process group.
  ``SIZE <r> <c>``    TIOCSWINSZ on the master.

There is no verb for asking about the child: the child's exit is already
reported on stderr by ``reap`` below, and a verb that cannot contradict
anything is worse than none — it reads like evidence it never produced.

The relay kills the group and exits on stdin EOF, on SIGTERM/SIGINT/SIGHUP, and
on its own exit path, so a dying parent can never orphan a live child.
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

VERB_KILL = b"KILL"
VERB_SIZE = b"SIZE"


def note(message):
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def main():
    if len(sys.argv) < 2:
        note("usage: pty_relay.py <cwd> <command> [args...]")
        return 2
    cwd = sys.argv[1]
    command = sys.argv[2:]

    pid, master = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
            os.execvp(command[0], command)
        except OSError as exc:
            sys.stderr.write("exec failed: %s\n" % exc)
            sys.stderr.flush()
        os._exit(127)

    def kill_group():
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass

    def set_size(rows, cols):
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            return True
        except OSError:
            return False

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: (kill_group(), os._exit(0)))

    set_size(40, 120)
    out = sys.stdout.buffer
    out.write(("CHILDPID %d\n" % pid).encode())
    out.flush()
    note("RELAY ready pid=%d" % pid)

    stdin_fd = sys.stdin.fileno()
    buffered = b""
    stop = False
    while not stop:
        try:
            ready, _, _ = select.select([master, stdin_fd], [], [], 0.2)
        except (OSError, ValueError):
            break
        for handle in ready:
            if handle == master:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    stop = True
                    break
                out.write(chunk)
                out.flush()
                continue
            try:
                data = os.read(stdin_fd, 65536)
            except OSError:
                data = b""
            if not data:
                kill_group()
                stop = True
                break
            buffered += data
            halting, consumed = consume_control(buffered, kill_group, set_size, master)
            buffered = buffered[consumed:]
            stop = halting or stop

    code, termsig = reap(pid)
    note("EXIT %s %s" % (code, termsig))
    kill_group()
    return 0


def consume_control(buffered, kill_group, set_size, master):
    """Forward stdin to the pty master, honouring control lines.

    Drains the whole buffer: the remainder past the first newline must not wait
    for the next stdin read, or the tail of a stimulus written in one chunk is
    stranded and the run times out on input that was only partly typed.

    Returns ``(stop, consumed_bytes)``.
    """
    consumed = 0
    halting = False
    while consumed < len(buffered):
        stop, step = consume_one(
            buffered[consumed:], kill_group, set_size, master
        )
        # Every path in `consume_one` consumes at least one byte; guard anyway so
        # a future one that does not can never spin the relay.
        if step <= 0:
            break
        consumed += step
        if stop:
            halting = True
            break
    return halting, consumed


def consume_one(buffered, kill_group, set_size, master):
    """Consume one line (or one newline-free run) and return (stop, bytes)."""
    newline = buffered.find(b"\n")
    if newline < 0:
        # No line terminator yet, so this cannot be a control line: forward it
        # verbatim. Stimulus text is paced in newline-free chunks for exactly
        # this reason.
        return forward(master, buffered), len(buffered)
    line = buffered[:newline]
    consumed = newline + 1
    verb = line.split(b" ", 1)[0].upper()
    if verb == VERB_KILL and line.strip() == VERB_KILL:
        kill_group()
        return True, consumed
    if verb == VERB_SIZE:
        parts = line.split()
        if len(parts) == 3 and set_size(int(parts[1]), int(parts[2])):
            note("SIZE ok %s %s" % (parts[1].decode(), parts[2].decode()))
        else:
            note("SIZE failed %r" % line)
        return False, consumed
    return forward(master, buffered[:consumed]), consumed


def forward(master, data):
    """Write to the pty master; a closed master stops the relay."""
    if data == b"":
        return False
    try:
        os.write(master, data)
    except OSError:
        return True
    return False


def reap(pid):
    """Wait for the child and report its exit as `(code, signal)`."""
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        return None, None
    code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
    term = os.WTERMSIG(status) if os.WIFSIGNALED(status) else None
    return code, term


if __name__ == "__main__":
    sys.exit(main())
#!/usr/bin/env python3
import json
import os
import select
import signal
import sys


def emit(result, **extra):
    print(json.dumps({"result": result, **extra}, separators=(",", ":")))


def identity(pid):
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii") as stat_file:
            raw = stat_file.read()
        fields = raw[raw.rfind(")") + 2:].split()
        if fields[0] in ("Z", "X", "x"):
            return {"result": "exited"}
        starttime = fields[19]
        try:
            image = os.readlink(f"/proc/{pid}/exe").removesuffix(" (deleted)")
        except OSError:
            image = f"comm:{raw[raw.find('(') + 1:raw.rfind(')')]}"
        with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as boot_file:
            boot_id = boot_file.read().strip()
        return {"result": "ok", "creationFileTime": f"{boot_id}:{starttime}", "image": image}
    except FileNotFoundError:
        return {"result": "exited"}
    except OSError as error:
        return {"result": "error", "code": "identityFailed", "message": str(error)}


def main():
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        emit("error", code="pidfdUnsupported", message="Python 3.9+ and Linux pidfd support are required")
        return

    pid = int(sys.argv[1])
    expected_creation = sys.argv[2]
    expected_image = sys.argv[3]
    wait_ms = max(0, int(sys.argv[4]))
    # 可选第 5 参：信号名（默认 SIGKILL；--grace 用 SIGTERM 温和先行）
    try:
        sig = getattr(signal, sys.argv[5]) if len(sys.argv) > 5 else signal.SIGKILL
    except AttributeError:
        emit("error", code="badArgs", message=f"unknown signal {sys.argv[5]}")
        return
    try:
        pidfd = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        emit("notfound")
        return
    except OSError as error:
        emit("error", code="pidfdOpenFailed", message=str(error))
        return

    try:
        current = identity(pid)
        if current["result"] != "ok":
            emit(current["result"], **{k: v for k, v in current.items() if k != "result"})
            return
        if current["creationFileTime"] != expected_creation:
            emit("mismatch", field="creationTime")
            return
        if current["image"] != expected_image:
            emit("mismatch", field="image")
            return
        try:
            signal.pidfd_send_signal(pidfd, sig)
        except ProcessLookupError:
            emit("exited")
            return
        except OSError as error:
            emit("error", code="terminateFailed", message=str(error))
            return

        poller = select.poll()
        poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
        if poller.poll(wait_ms):
            emit("terminated")
        else:
            emit("terminateTimeout")
    finally:
        os.close(pidfd)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, IndexError) as error:
        emit("error", code="badArgs", message=str(error))

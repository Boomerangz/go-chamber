package pty

import (
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

// sessionMembers lists the processes whose session id is sid.
func sessionMembers(sid int) ([]int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	var pids []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if s, err := unix.Getsid(pid); err == nil && s == sid {
			pids = append(pids, pid)
		}
	}
	return pids, nil
}

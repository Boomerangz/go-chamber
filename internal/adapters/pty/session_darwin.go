package pty

import "golang.org/x/sys/unix"

// sessionMembers lists the processes whose session id is sid.
func sessionMembers(sid int) ([]int, error) {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, err
	}
	var pids []int
	for _, p := range procs {
		pid := int(p.Proc.P_pid)
		if s, err := unix.Getsid(pid); err == nil && s == sid {
			pids = append(pids, pid)
		}
	}
	return pids, nil
}

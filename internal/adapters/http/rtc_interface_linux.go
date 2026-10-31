package httpapi

import (
	"net"

	"golang.org/x/sys/unix"
)

func bindRTCInterface(fd uintptr, _ string, iface net.Interface) error {
	return unix.SetsockoptString(int(fd), unix.SOL_SOCKET, unix.SO_BINDTODEVICE, iface.Name)
}

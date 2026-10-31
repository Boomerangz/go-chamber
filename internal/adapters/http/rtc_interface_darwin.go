package httpapi

import (
	"net"

	"golang.org/x/sys/unix"
)

func bindRTCInterface(fd uintptr, network string, iface net.Interface) error {
	level, option := unix.IPPROTO_IP, unix.IP_BOUND_IF
	if network == "udp6" {
		level, option = unix.IPPROTO_IPV6, unix.IPV6_BOUND_IF
	}
	return unix.SetsockoptInt(int(fd), level, option, iface.Index)
}

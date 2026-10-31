package httpapi

import (
	"net"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestRTCUDPBoundToRequestedInterface(t *testing.T) {
	for _, network := range []string{"udp4", "udp6"} {
		t.Run(network, func(t *testing.T) {
			n, err := newRTCInterfaceNet("lo0")
			if err != nil {
				t.Fatal(err)
			}
			ip, level, option := net.IPv4(127, 0, 0, 1), unix.IPPROTO_IP, unix.IP_BOUND_IF
			if network == "udp6" {
				ip, level, option = net.IPv6loopback, unix.IPPROTO_IPV6, unix.IPV6_BOUND_IF
			}
			conn, err := n.ListenUDP(network, &net.UDPAddr{IP: ip})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = conn.Close() }()
			raw, err := conn.(syscall.Conn).SyscallConn()
			if err != nil {
				t.Fatal(err)
			}
			var index int
			var socketErr error
			if err := raw.Control(func(fd uintptr) { index, socketErr = unix.GetsockoptInt(int(fd), level, option) }); err != nil {
				t.Fatal(err)
			}
			iface, _ := net.InterfaceByName("lo0")
			if socketErr != nil || index != iface.Index {
				t.Fatalf("interface=%d error=%v", index, socketErr)
			}
			receiver, err := net.ListenUDP(network, &net.UDPAddr{IP: ip})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = receiver.Close() }()
			if _, err := conn.WriteTo([]byte("rtc-probe"), receiver.LocalAddr()); err != nil {
				t.Fatal(err)
			}
			if err := receiver.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, 32)
			count, _, err := receiver.ReadFrom(buf)
			if err != nil || string(buf[:count]) != "rtc-probe" {
				t.Fatalf("receive: %q %v", buf[:count], err)
			}
		})
	}
}

func TestRTCInterfaceRejectsUnknownInterface(t *testing.T) {
	if _, err := newRTCInterfaceNet("go-chamber-nonexistent"); err == nil {
		t.Fatal("accepted nonexistent interface")
	}
}

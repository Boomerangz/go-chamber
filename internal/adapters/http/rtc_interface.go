package httpapi

import (
	"errors"
	"net"
	"syscall"

	"github.com/pion/transport/v5"
	"github.com/pion/transport/v5/stdnet"
)

// Source-address filtering alone does not pin a route on a split-VPN host.
// Bind the actual UDP socket so discovery and peer checks use the same link.
type rtcInterfaceNet struct {
	transport.Net
	iface net.Interface
}

func newRTCInterfaceNet(name string) (*rtcInterfaceNet, error) {
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return nil, err
	}
	if iface.Flags&net.FlagUp == 0 {
		return nil, errors.New("RTC interface is down")
	}
	base, err := stdnet.NewNet()
	if err != nil {
		return nil, err
	}
	return &rtcInterfaceNet{Net: base, iface: *iface}, nil
}

func (n *rtcInterfaceNet) ListenUDP(network string, addr *net.UDPAddr) (transport.UDPConn, error) {
	conn, err := n.Net.ListenUDP(network, addr)
	if err != nil {
		return nil, err
	}
	socket, ok := conn.(syscall.Conn)
	if !ok {
		_ = conn.Close()
		return nil, errors.New("RTC UDP socket does not support interface binding")
	}
	raw, err := socket.SyscallConn()
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	var bindErr error
	err = raw.Control(func(fd uintptr) { bindErr = bindRTCInterface(fd, network, n.iface) })
	if err != nil || bindErr != nil {
		_ = conn.Close()
		return nil, errors.Join(err, bindErr)
	}
	return conn, nil
}

//go:build !darwin && !linux

package httpapi

import (
	"errors"
	"net"
)

func bindRTCInterface(uintptr, string, net.Interface) error {
	return errors.New("RTC interface binding is unsupported on this platform")
}

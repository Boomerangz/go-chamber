package oauth

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"time"
)

// Metadata URLs are supplied by unauthenticated clients. Never let a document
// fetch reach a private address, including after a DNS rebinding: resolve once,
// check every answer, then dial the checked IP with the original HTTPS SNI.
func metadataHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		return dialPublic(ctx, network, address, net.DefaultResolver.LookupIPAddr, dialer.DialContext)
	}
	return &http.Client{Transport: transport, Timeout: 5 * time.Second}
}

var reservedNetworks = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
}

var globalIPv6 = netip.MustParsePrefix("2000::/3")

func publicIP(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.Is6() && !globalIPv6.Contains(addr) {
		return false
	}
	for _, network := range reservedNetworks {
		if network.Contains(addr) {
			return false
		}
	}
	return true
}

func dialPublic(
	ctx context.Context, network, address string,
	resolve func(context.Context, string) ([]net.IPAddr, error),
	dial func(context.Context, string, string) (net.Conn, error),
) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(addresses) == 0 {
		return nil, errors.New("client metadata host has no addresses")
	}
	for _, addr := range addresses {
		if !publicIP(addr.IP) {
			return nil, errors.New("client metadata host resolves to a non-public address")
		}
	}
	return dial(ctx, network, net.JoinHostPort(addresses[0].IP.String(), port))
}

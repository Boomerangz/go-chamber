package oauth

import (
	"context"
	"errors"
	"net"
	"testing"
)

func TestMetadataDialRejectsPrivateDNSBeforeConnecting(t *testing.T) {
	for name, addresses := range map[string][]net.IPAddr{
		"loopback":                 {{IP: net.ParseIP("127.0.0.1")}},
		"private":                  {{IP: net.ParseIP("192.168.0.35")}},
		"link local":               {{IP: net.ParseIP("169.254.1.1")}},
		"carrier grade NAT":        {{IP: net.ParseIP("100.64.0.1")}},
		"benchmark network":        {{IP: net.ParseIP("198.18.0.1")}},
		"IPv4 documentation one":   {{IP: net.ParseIP("192.0.2.1")}},
		"IPv4 documentation two":   {{IP: net.ParseIP("198.51.100.1")}},
		"IPv4 documentation three": {{IP: net.ParseIP("203.0.113.1")}},
		"IPv6 unique local":        {{IP: net.ParseIP("fd00::1")}},
		"IPv6 site local":          {{IP: net.ParseIP("fec0::1")}},
		"IPv6 documentation":       {{IP: net.ParseIP("2001:db8::1")}},
		"IPv6 documentation new":   {{IP: net.ParseIP("3fff::1")}},
		"IPv6 tunneled":            {{IP: net.ParseIP("2002:c0a8:0001::1")}},
		"mixed public and private": {{IP: net.ParseIP("1.1.1.1")}, {IP: net.ParseIP("127.0.0.1")}},
	} {
		t.Run(name, func(t *testing.T) {
			dialed := false
			_, err := dialPublic(context.Background(), "tcp", "client.example.org:443",
				func(context.Context, string) ([]net.IPAddr, error) { return addresses, nil },
				func(context.Context, string, string) (net.Conn, error) {
					dialed = true
					return nil, errors.New("dialed")
				})
			if err == nil || dialed {
				t.Fatalf("private DNS was dialed: err=%v, dialed=%v", err, dialed)
			}
		})
	}
}

func TestMetadataDialPinsResolvedPublicAddress(t *testing.T) {
	var dialAddress string
	_, err := dialPublic(context.Background(), "tcp", "client.example.org:443",
		func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("1.1.1.1")}}, nil
		},
		func(_ context.Context, _, address string) (net.Conn, error) {
			dialAddress = address
			return nil, errors.New("expected dial probe")
		})
	if dialAddress != "1.1.1.1:443" || err == nil {
		t.Fatalf("did not dial pinned public address: %q, %v", dialAddress, err)
	}
}

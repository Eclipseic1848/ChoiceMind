import { describe, expect, it } from "vitest";

import { isPublicNetworkAddress } from "./public-network-policy.js";

describe("isPublicNetworkAddress", () => {
	it.each([
		["IPv4 0/8", "0.1.2.3"],
		["IPv4 private 10/8", "10.255.255.255"],
		["IPv4 carrier-grade NAT 100.64/10", "100.127.255.255"],
		["IPv4 loopback 127/8", "127.0.0.1"],
		["IPv4 link-local 169.254/16", "169.254.255.255"],
		["IPv4 private 172.16/12", "172.31.255.255"],
		["IPv4 protocol assignments 192.0.0/24", "192.0.0.9"],
		["IPv4 documentation 192.0.2/24", "192.0.2.1"],
		["IPv4 deprecated 6to4 relay 192.88.99/24", "192.88.99.1"],
		["IPv4 private 192.168/16", "192.168.255.255"],
		["IPv4 benchmarking 198.18/15", "198.19.255.255"],
		["IPv4 documentation 198.51.100/24", "198.51.100.1"],
		["IPv4 documentation 203.0.113/24", "203.0.113.1"],
		["IPv4 multicast 224/4", "239.255.255.255"],
		["IPv4 reserved 240/4", "255.255.255.255"],
		["IPv6 unspecified", "::"],
		["IPv6 loopback", "::1"],
		["IPv4-compatible IPv6 ::/96", "::192.168.1.1"],
		["IPv4-mapped IPv6", "::ffff:192.168.1.1"],
		["IPv4-mapped IPv6 in hexadecimal form", "::ffff:c000:201"],
		["IPv6 translation prefix 64:ff9b::/96", "64:ff9b::808:808"],
		["IPv6 local-use translation prefix 64:ff9b:1::/48", "64:ff9b:1:ffff::1"],
		["IPv6 discard-only 100::/64", "100::1"],
		["IPv6 dummy prefix 100:0:0:1::/64", "100:0:0:1:ffff::1"],
		["IPv6 Teredo 2001::/32", "2001::1"],
		["IPv6 benchmarking 2001:2::/48", "2001:2:0:ffff::1"],
		["IPv6 ORCHID 2001:10::/28", "2001:10::1"],
		["IPv6 ORCHIDv2 2001:20::/28", "2001:20::1"],
		["IPv6 documentation 2001:db8::/32", "2001:db8::1"],
		["IPv6 6to4 2002::/16", "2002:c000:201::"],
		["IPv6 documentation 3fff::/20", "3fff:fff::1"],
		["IPv6 segment routing SIDs 5f00::/16", "5f00:ffff::1"],
		["IPv6 unique-local fc00::/7", "fdff:ffff:ffff:ffff::1"],
		["IPv6 link-local fe80::/10", "febf:ffff:ffff:ffff::1"],
		["IPv6 deprecated site-local fec0::/10", "feff:ffff:ffff:ffff::1"],
		["IPv6 multicast ff00::/8", "ff02::1"],
	])("拒绝 %s 地址 %s", (_range, address) => {
		expect(isPublicNetworkAddress(address)).toBe(false);
	});

	it.each([
		["IPv4", "8.8.8.8"],
		["IPv4", "93.184.216.34"],
		["IPv6", "2001:4860:4860::8888"],
		["IPv6", "2606:4700:4700::1111"],
	])("允许代表性公网 %s 地址 %s", (_family, address) => {
		expect(isPublicNetworkAddress(address)).toBe(true);
	});

	it.each([
		"",
		"localhost",
		"999.0.0.1",
		"1.2.3",
		"2001:::1",
		"[::1]",
		" 8.8.8.8 ",
	])("无效地址 %j 返回 false", (address) => {
		expect(isPublicNetworkAddress(address)).toBe(false);
	});
});

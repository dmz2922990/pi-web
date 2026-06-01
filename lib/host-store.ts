import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { HostConfig } from "./host-types";

// --- Path ---

function getHostsPath(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "/";
	return join(homeDir, ".pi", "agent", "hosts.json");
}

// --- Cache ---

interface HostCache {
	data: HostConfig[];
	loaded: boolean;
}

function getCache(): HostCache {
	if (!(globalThis as Record<string, unknown>).__piHostsCache) {
		(globalThis as Record<string, unknown>).__piHostsCache = {
			data: [],
			loaded: false,
		};
	}
	return (globalThis as Record<string, unknown>).__piHostsCache as HostCache;
}

function invalidateCache(): void {
	const cache = getCache();
	cache.data = [];
	cache.loaded = false;
}

// --- Read/Write ---

function readHostsFromDisk(): HostConfig[] {
	const path = getHostsPath();
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
}

function writeHostsToDisk(hosts: HostConfig[]): void {
	const path = getHostsPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(hosts, null, 2), "utf8");
}

// --- Public API ---

export function listHosts(): HostConfig[] {
	const cache = getCache();
	if (!cache.loaded) {
		cache.data = readHostsFromDisk();
		cache.loaded = true;
	}
	return cache.data;
}

export function getHost(id: string): HostConfig | undefined {
	return listHosts().find((h) => h.id === id);
}

export function createHost(
	partial: Omit<HostConfig, "id" | "createdAt">,
): HostConfig {
	const hosts = listHosts();
	const host: HostConfig = {
		...partial,
		id: randomUUID(),
		createdAt: new Date().toISOString(),
	};
	hosts.push(host);
	writeHostsToDisk(hosts);
	invalidateCache();
	return host;
}

export function updateHost(
	id: string,
	patch: Partial<Omit<HostConfig, "id" | "createdAt">>,
): HostConfig | undefined {
	const hosts = listHosts();
	const idx = hosts.findIndex((h) => h.id === id);
	if (idx === -1) return undefined;
	Object.assign(hosts[idx], patch);
	writeHostsToDisk(hosts);
	invalidateCache();
	return hosts[idx];
}

export function deleteHost(id: string): boolean {
	const hosts = listHosts();
	const idx = hosts.findIndex((h) => h.id === id);
	if (idx === -1) return false;
	hosts.splice(idx, 1);
	writeHostsToDisk(hosts);
	invalidateCache();
	return true;
}

export function saveAllHosts(hosts: HostConfig[]): void {
	writeHostsToDisk(hosts);
	invalidateCache();
}

export interface HostConfig {
	id: string;
	name: string;
	host: string;
	port: number;
	user?: string;
	authType: "password" | "privateKey";
	password?: string;
	privateKey?: string;
	remoteCwd?: string;
	createdAt: string;
}

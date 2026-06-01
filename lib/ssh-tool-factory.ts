import { createCodingTools, type ToolsOptions } from "@earendil-works/pi-coding-agent";
import { SshConnection, createSshOperations } from "./ssh-operations";

export function createSshTools(cwd: string, sshConn: SshConnection): ReturnType<typeof createCodingTools> {
	const ops = createSshOperations(sshConn);

	const toolsOptions: ToolsOptions = {
		bash: { operations: ops.bash },
		read: { operations: ops.read },
		write: { operations: ops.write },
		edit: { operations: ops.edit },
		grep: { operations: ops.grep },
		find: { operations: ops.find },
		ls: { operations: ops.ls },
	};

	return createCodingTools(cwd, toolsOptions);
}

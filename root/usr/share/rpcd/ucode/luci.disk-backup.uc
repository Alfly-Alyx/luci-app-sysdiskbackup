#!/usr/bin/env ucode

'use strict';

import { error, popen } from 'fs';

function shellquote(value) {
	return `'${replace(value, "'", "'\\''")}'`;
}

function invoke(args) {
	let command = '/usr/libexec/luci-disk-backup';

	for (let arg in args)
		command += ' ' + shellquote(arg);

	const fd = popen(command + ' 2>/dev/null', 'r');
	if (!fd)
		return { ok: false, error: error() || 'Unable to start backend' };

	const output = fd.read('all');
	fd.close();

	try {
		return json(output);
	}
	catch (err) {
		return { ok: false, error: 'Invalid backend response', detail: `${err}` };
	}
}

const methods = {
	probe: {
		call: function() {
			return invoke([ 'probe' ]);
		}
	},

	status: {
		call: function() {
			return invoke([ 'status' ]);
		}
	},

	start: {
		args: { target: '', source: 'auto' },
		call: function(request) {
			const target = request.args.target;
			const source = request.args.source;

			if (type(target) != 'string' || !match(target, /^[A-Za-z0-9._-]+$/))
				return { ok: false, error: 'Invalid destination identifier' };
			if (type(source) != 'string' || !match(source, /^(auto|[A-Za-z0-9._-]+)$/))
				return { ok: false, error: 'Invalid source disk identifier' };

			return invoke([ 'start', target, source ]);
		}
	},

	cancel: {
		call: function() {
			return invoke([ 'cancel' ]);
		}
	}
};

return { 'luci.disk-backup': methods };

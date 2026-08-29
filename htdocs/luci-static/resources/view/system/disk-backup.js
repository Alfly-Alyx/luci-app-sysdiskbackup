'use strict';
'require dom';
'require poll';
'require rpc';
'require ui';
'require view';

const callProbe = rpc.declare({
	object: 'luci.disk-backup',
	method: 'probe',
	expect: { '': {} }
});

const callStatus = rpc.declare({
	object: 'luci.disk-backup',
	method: 'status',
	expect: { '': {} }
});

const callStart = rpc.declare({
	object: 'luci.disk-backup',
	method: 'start',
	params: [ 'target', 'source' ],
	expect: { '': {} }
});

const callCancel = rpc.declare({
	object: 'luci.disk-backup',
	method: 'cancel',
	expect: { '': {} }
});

function formatBytes(value) {
	let bytes = Number(value || 0);
	const units = [ _('B'), _('KiB'), _('MiB'), _('GiB'), _('TiB') ];
	let unit = 0;

	while (bytes >= 1024 && unit < units.length - 1) {
		bytes /= 1024;
		unit++;
	}

	return '%s %s'.format(bytes.toFixed(unit ? 2 : 0), units[unit]);
}

function formatDuration(value) {
	let seconds = Math.max(0, Math.round(Number(value || 0)));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	seconds %= 60;

	if (hours)
		return _('%dh %dm %ds').format(hours, minutes, seconds);
	if (minutes)
		return _('%dm %ds').format(minutes, seconds);
	return _('%ds').format(seconds);
}

function statusClass(status) {
	switch (status) {
	case 'completed': return 'alert-message success';
	case 'failed': return 'alert-message danger';
	case 'cancelled': return 'alert-message warning';
	default: return 'alert-message notice';
	}
}

function statusMessage(status) {
	if (status.status === 'completed')
		return _('System image completed successfully');
	if (status.status === 'cancelled')
		return _('Backup cancelled');
	if (status.status === 'failed')
		return status.error ? _(status.error) : _('Backup failed');

	switch (status.stage) {
	case 'prepare': return _('Preparing the system image');
	case 'copy': return _('Copying the system disk');
	case 'gpt': return _('Relocating the backup GPT header');
	case 'checksum': return _('Calculating the SHA-256 checksum');
	case 'finalize': return _('Finalizing the image');
	default: return status.message || _('Idle');
	}
}

function destinationReason(reason) {
	switch (reason) {
	case 'Not enough free space for the image':
		return _('Not enough free space for the image');
	case 'FAT32 cannot store an image of 4 GiB or more':
		return _('FAT32 cannot store an image of 4 GiB or more');
	case 'FAT32 split image: reassemble the parts before flashing':
		return _('FAT32 split image: reassemble the parts before flashing');
	case 'The USB filesystem is not mounted read-write':
		return _('The USB filesystem is not mounted read-write');
	case 'No usable filesystem was recognized on this block device':
		return _('No usable filesystem was recognized on this block device');
	case 'The USB filesystem is not mounted':
		return _('The USB filesystem is not mounted');
	default:
		return reason ? _(reason) : _('Unavailable');
	}
}

return view.extend({
	load: function() {
		return Promise.all([ callProbe(), callStatus() ]);
	},

	refresh: function() {
		return Promise.all([ callProbe(), callStatus() ]).then(L.bind(function(data) {
			const container = document.getElementById('disk-backup-content');
			const active = document.activeElement;
			const editing = this.formControlActive || (active && container && container.contains(active) &&
				(active.tagName === 'SELECT' || active.tagName === 'INPUT'));

			if (container && !editing)
				dom.content(container, this.renderContent(data[0] || {}, data[1] || {}));
		}, this));
	},

	controlFocus: function() {
		this.formControlActive = true;
	},

	controlBlur: function() {
		this.formControlActive = false;
	},

	startBackup: function(target, source) {
		ui.hideModal();
		return callStart(target, source || 'auto').then(L.bind(function(result) {
			if (!result.ok)
				throw new Error(result.error ? _(result.error) : _('Unable to start the backup'));
			return this.refresh();
		}, this)).catch(function(err) {
			ui.addNotification(null, E('p', {}, [ err.message ]));
		});
	},

	confirmBackup: function(ev) {
		const select = document.getElementById('disk-backup-target');
		const sourceSelect = document.getElementById('disk-backup-source');
		const target = select ? select.value : '';
		const label = select && select.selectedIndex >= 0 ? select.options[select.selectedIndex].text : target;
		const source = sourceSelect ? sourceSelect.value.trim() : 'auto';
		const sourceLabel = sourceSelect && sourceSelect.selectedIndex >= 0 ? sourceSelect.options[sourceSelect.selectedIndex].text : source;
		const split = select && select.selectedIndex >= 0 && select.options[select.selectedIndex].getAttribute('data-split') === '1';

		if (!source) {
			ui.addNotification(null, E('p', {}, [ _('Enter or select a source disk.') ]));
			return;
		}
		if (!target)
			return;

		const content = [
			E('p', {}, [ _('The active system disk will be read while OpenWrt is running. Avoid configuration changes and do not disconnect the USB device until completion.') ]),
			E('p', {}, [ E('strong', {}, [ _('Source disk:') ]), ' ', source === 'auto' ? _('Automatically detected') : sourceLabel ]),
			E('p', {}, [ E('strong', {}, [ _('USB destination:') ]), ' ', label ])
		];

		if (source !== 'auto')
			content.push(E('div', { 'class': 'alert-message warning' }, [ _('Manual source selection is active. Verify the disk carefully; the package cannot prove that it contains the running system.') ]));
		if (split)
			content.push(E('div', { 'class': 'alert-message warning' }, [ _('This FAT32 destination will receive split image files. Reassemble them on an NTFS, exFAT, ext4 or other large-file filesystem before using Balena Etcher or Rufus. No pre-existing file on the USB device will be deleted or overwritten.') ]));

		content.push(
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action important',
					'click': ui.createHandlerFn(this, 'startBackup', target, source)
				}, [ _('Start backup') ])
			])
		);

		ui.showModal(_('Create system image'), content);
	},

	cancelBackup: function() {
		return callCancel().then(L.bind(function(result) {
			if (!result.ok)
				throw new Error(result.error ? _(result.error) : _('Unable to cancel the backup'));
			return this.refresh();
		}, this)).catch(function(err) {
			ui.addNotification(null, E('p', {}, [ err.message ]));
		});
	},

	renderSystem: function(system, sources, disabled) {
		if (!system.supported) {
			const options = [];
			const sourceFields = [];
			let selected = this.manualSource || '';

			if (sources.length && !sources.some(function(source) { return source.token === selected; }))
				selected = sources[0].token;
			this.manualSource = selected;

			for (const source of sources) {
				const suffix = source.usb ? ' — %s'.format(_('USB device')) : '';
				options.push(E('option', {
					'value': source.token,
					'selected': source.token === selected ? '' : null
				}, [ '%s — %s — %s%s'.format(source.device, source.description, formatBytes(source.disk_bytes), suffix) ]));
			}

			if (options.length) {
					sourceFields.push(E('select', {
						'id': 'disk-backup-source',
						'class': 'cbi-input-select',
						'disabled': disabled ? '' : null,
						'focus': L.bind(this.controlFocus, this),
						'blur': L.bind(this.controlBlur, this),
						'change': L.bind(function(ev) { this.manualSource = ev.target.value; }, this)
					}, options));
			}
			else {
				sourceFields.push(E('input', {
					'id': 'disk-backup-source',
					'class': 'cbi-input-text',
					'type': 'text',
						'value': selected,
						'placeholder': 'mmcblk0',
						'disabled': disabled ? '' : null,
						'focus': L.bind(this.controlFocus, this),
						'blur': L.bind(this.controlBlur, this),
						'input': L.bind(function(ev) { this.manualSource = ev.target.value.trim(); }, this)
					}));
				sourceFields.push(E('p', {}, [
					_('No compatible physical disk was enumerated automatically. Enter the whole disk name, for example mmcblk0 or nvme0n1.')
				]));
			}

			sourceFields.push(E('div', { 'class': 'alert-message warning', 'style': 'margin-top:1em' }, [
				_('Use manual selection only when you know which whole disk contains the boot sectors and the running OpenWrt installation.')
			]));

			return E('div', {}, [
				E('div', { 'class': 'alert-message danger' }, [
					E('strong', {}, [ _('Automatic detection failed') ]),
					E('br'),
					system.error ? _(system.error) : _('The active system disk could not be identified safely.')
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('label', { 'class': 'cbi-value-title', 'for': 'disk-backup-source' }, [ _('Manual source disk') ]),
					E('div', { 'class': 'cbi-value-field' }, sourceFields)
				])
			]);
		}

		const detectedTable = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left', 'width': '35%' }, [ _('Detected system disk') ]), E('td', { 'class': 'td left' }, [ E('strong', {}, [ system.device ]), ' — ', system.description ] ) ]),
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, [ _('Physical disk size') ]), E('td', { 'class': 'td left' }, [ formatBytes(system.disk_bytes) ]) ]),
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, [ _('Image size') ]), E('td', { 'class': 'td left' }, [ formatBytes(system.image_bytes) ]) ]),
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, [ _('Last included partition') ]), E('td', { 'class': 'td left' }, [ system.last_partition || _('Whole disk (no partition table)') ]) ]),
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, [ _('Partition table') ]), E('td', { 'class': 'td left' }, [ system.gpt ? _('GPT (backup header will be relocated)') : _('MBR or unpartitioned') ]) ])
		]);
		const sourceOptions = [ E('option', { 'value': 'auto' }, [ _('Automatic detection (recommended): %s').format(system.device) ]) ];
		let selected = this.manualSource || 'auto';

		for (const source of sources) {
			const suffix = source.usb ? ' — %s'.format(_('USB device')) : '';
			sourceOptions.push(E('option', {
				'value': source.token,
				'selected': source.token === selected ? '' : null
			}, [ '%s — %s — %s%s'.format(_('Force'), source.device, formatBytes(source.disk_bytes), suffix) ]));
		}
		if (selected !== 'auto' && !sources.some(function(source) { return source.token === selected; }))
			selected = 'auto';
		this.manualSource = selected;

		return E('div', {}, [
			detectedTable,
			E('div', { 'class': 'cbi-section' }, [
				E('label', { 'class': 'cbi-value-title', 'for': 'disk-backup-source' }, [ _('Source mode') ]),
				E('div', { 'class': 'cbi-value-field' }, [
					E('select', {
						'id': 'disk-backup-source',
						'class': 'cbi-input-select',
						'disabled': disabled ? '' : null,
						'focus': L.bind(this.controlFocus, this),
						'blur': L.bind(this.controlBlur, this),
						'change': L.bind(function(ev) { this.manualSource = ev.target.value; }, this)
					}, sourceOptions),
					E('p', {}, [ _('Automatic detection is recommended. Force a whole source disk only when you have verified it independently.') ])
				])
			])
		]);
	},

	renderDestinations: function(destinations, disabled) {
		const rows = [];
		const options = [];

		let selected = this.destination || '';
		if (!destinations.some(function(destination) { return destination.token === selected && destination.eligible; }))
			selected = '';

		for (const destination of destinations) {
			const splitSuffix = destination.split ? ' — %s'.format(_('FAT32 split files')) : '';
			const name = '%s — %s — %s free%s'.format(destination.device, destination.description, formatBytes(destination.free_bytes), splitSuffix);
			if (destination.eligible) {
				if (!selected)
					selected = destination.token;
				options.push(E('option', {
					'value': destination.token,
					'selected': destination.token === selected ? '' : null,
					'data-split': destination.split ? '1' : '0'
				}, [ name ]));
			}
			const status = destination.eligible
				? (destination.split
					? E('span', {}, [ E('span', { 'class': 'label warning' }, [ _('USB ready — split FAT32') ]), E('br'), destinationReason(destination.reason) ])
					: E('span', { 'class': 'label success' }, [ _('USB ready') ]))
				: E('span', {}, [ E('span', { 'class': 'label warning' }, [ _('Unsuitable') ]), E('br'), destinationReason(destination.reason) ]);

			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, [ E('strong', {}, [ destination.device ]), E('br'), destination.description ]),
				E('td', { 'class': 'td left' }, [ destination.mountpoint || _('Not mounted') ]),
				E('td', { 'class': 'td left' }, [ destination.filesystem || '-' ]),
				E('td', { 'class': 'td left' }, [ destination.free_known ? formatBytes(destination.free_bytes) : '—', ' / ', formatBytes(destination.total_bytes) ]),
				E('td', { 'class': 'td left' }, [ status ])
			]));
		}

		const tableRows = [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th left' }, [ _('USB device') ]),
				E('th', { 'class': 'th left' }, [ _('Mount point') ]),
				E('th', { 'class': 'th left' }, [ _('Filesystem') ]),
				E('th', { 'class': 'th left' }, [ _('Free / total') ]),
				E('th', { 'class': 'th left' }, [ _('Status') ])
			])
		];

		if (rows.length) {
			for (const row of rows)
				tableRows.push(row);
		}
		else {
			tableRows.push(E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td', 'colspan': 5 }, [ E('em', {}, [ _('No USB storage device was detected. Connect one, then refresh this page.') ]) ]) ]));
		}

		const table = E('table', { 'class': 'table' }, tableRows);

		this.destination = selected;
		return E('div', {}, [
			table,
			E('div', { 'class': 'cbi-section' }, [
				E('label', { 'class': 'cbi-value-title', 'for': 'disk-backup-target' }, [ _('Image destination') ]),
				E('div', { 'class': 'cbi-value-field' }, [
					E('select', {
						'id': 'disk-backup-target',
						'class': 'cbi-input-select',
						'disabled': disabled || !options.length ? '' : null,
						'focus': L.bind(this.controlFocus, this),
						'blur': L.bind(this.controlBlur, this),
						'change': L.bind(function(ev) { this.destination = ev.target.value; }, this)
					}, options),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-action important',
						'disabled': disabled || !options.length ? '' : null,
						'click': ui.createHandlerFn(this, 'confirmBackup')
					}, [ _('Create image') ])
				])
			])
		]);
	},

	renderStatus: function(status) {
		const running = [ 'starting', 'running', 'cancelling' ].indexOf(status.status) >= 0;
		const output = [];

		output.push(E('div', { 'class': statusClass(status.status) }, [
			E('strong', {}, [ statusMessage(status) ])
		]));

		if (running || status.status === 'completed' || status.elapsed_seconds != null) {
			output.push(E('div', { 'style': 'margin-top:1em' }, [
				E('div', { 'style': 'height:1.2em;background:#ddd;border-radius:3px;overflow:hidden' }, [
					E('div', { 'style': 'height:100%;width:%d%%;background:#5e9f40;transition:width .3s'.format(Number(status.percent || 0)) })
				]),
				E('div', { 'class': 'right' }, [ '%d%%'.format(Number(status.percent || 0)) ])
			]));

			output.push(E('table', { 'class': 'table', 'style': 'margin-top:1.5em' }, [
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'width': '33%' }, [ E('strong', {}, [ _('Elapsed time') ]) ]),
					E('td', { 'class': 'td left', 'width': '33%' }, [ E('strong', {}, [ _('Estimated time remaining') ]) ]),
					E('td', { 'class': 'td left' }, [ E('strong', {}, [ _('Data write speed') ]) ])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left' }, [ formatDuration(status.elapsed_seconds) ]),
					E('td', { 'class': 'td left' }, [ status.eta_seconds != null ? formatDuration(status.eta_seconds) : _('Calculating…') ]),
					E('td', { 'class': 'td left' }, [ status.write_bps != null ? _('%s/s').format(formatBytes(status.write_bps)) : _('Calculating…') ])
				])
			]));
		}

		if (status.output)
			output.push(E('p', {}, [ E('strong', {}, [ _('Image:') ]), ' ', status.output ]));
		if (status.segmented)
			output.push(E('div', { 'class': 'alert-message warning' }, [
				_('FAT32 split backup: %d parts. Reassemble them before flashing.').format(Number(status.part_count || 0)),
				status.merge_windows ? E('div', {}, [ _('Windows merge script:'), ' ', status.merge_windows ]) : '',
				status.merge_unix ? E('div', {}, [ _('Linux/macOS merge script:'), ' ', status.merge_unix ]) : ''
			]));
		if (status.sha256)
			output.push(E('p', {}, [ E('strong', {}, [ _('SHA-256:') ]), ' ', E('code', {}, [ status.sha256 ]) ]));
		if (running)
			output.push(E('button', { 'class': 'btn cbi-button-negative', 'click': ui.createHandlerFn(this, 'cancelBackup') }, [ _('Cancel backup') ]));

		return E('div', {}, output);
	},

	renderContent: function(probe, status) {
		const system = probe.system || {};
		const sources = probe.sources || [];
		const destinations = probe.destinations || [];
		const running = [ 'starting', 'running', 'cancelling' ].indexOf(status.status) >= 0;

		return E('div', {}, [
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Source') ]),
				this.renderSystem(system, sources, running)
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('USB destination') ]),
				this.renderDestinations(destinations, running)
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Backup status') ]),
				this.renderStatus(status)
			]),
			E('div', { 'class': 'alert-message warning' }, [
				E('strong', {}, [ _('Live image warning') ]), E('br'),
				_('The image is crash-consistent, not an atomic snapshot. For the strongest guarantee, create it from a recovery system with the source disk unmounted. NAND/UBI/MTD flash is intentionally unsupported.')
			])
		]);
	},

	render: function(data) {
		poll.add(L.bind(this.refresh, this), 2);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('System image backup') ]),
			E('div', { 'class': 'cbi-map-descr' }, [ _('Create a raw .img file at the root of a mounted USB filesystem. The image includes the boot sectors and partition table and can be written with Balena Etcher, Rufus or dd.') ]),
			E('div', { 'id': 'disk-backup-content' }, [ this.renderContent(data[0] || {}, data[1] || {}) ])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});

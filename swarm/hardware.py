"""Fail-closed UNO Q preparation; no serial device is opened by this demo."""
import json
from .task import ROOT


def configuration():
    return json.loads((ROOT / 'config/uno-q.json').read_text())


def prepare(action, config):
    direction = 'increasing' if action['sweep_end_deg'] > action['sweep_start_deg'] else 'decreasing'
    mapping = config['direction_commands']
    verified = (config.get('calibration_verified') is True and bool(config.get('calibration_id'))
                and set(mapping.values()) == {'L', 'R'})
    for field, values in [('servo_limits_deg', [action['sweep_start_deg'], action['sweep_end_deg']]),
                          ('tilt_limits_deg', [action['tilt_deg']])]:
        limits = config.get(field)
        verified = verified and isinstance(limits, list) and len(limits)==2 and limits[0]<limits[1]
        if verified and not all(limits[0] <= value <= limits[1] for value in values):
            raise ValueError('Action outside calibrated hardware limits')
    return dict(command=mapping[direction] if verified else None, calibrated=bool(verified),
                tilt_deg=action['tilt_deg'], transmitted=False, acknowledged=False,
                reason='Physical execution disabled: UNO Q acknowledgement and safe serial integration have not been verified. Close servo_keys.py and Serial Monitor before any future single-owner serial connection. Stop: disconnect servo power physically.')

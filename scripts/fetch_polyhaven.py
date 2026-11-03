#!/usr/bin/env python3
"""
Download curated CC0 luxury architectural models from Poly Haven.
"""
import os
import sys
import json
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODELS_DIR = os.path.join(ROOT, 'assets', 'models')
os.makedirs(MODELS_DIR, exist_ok=True)

TARGETS = [
    'sofa_02',
    'modern_arm_chair_01',
    'dining_chair_02',
    'brass_pot_01',
]

def fetch_asset(asset_id, res='1k'):
    url = f"https://api.polyhaven.com/files/{asset_id}"
    req = urllib.request.Request(url, headers={'User-Agent': 'ArchVizImporter/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"Skipping {asset_id}: {e}")
        return False

    gltf_group = data.get('gltf', {})
    if res not in gltf_group:
        res = list(gltf_group.keys())[0] if gltf_group else None
    if not res:
        print(f"No GLTF available for {asset_id}")
        return False

    res_obj = gltf_group[res]
    # Poly haven structure: res_obj['gltf']['url']
    entry = res_obj.get('gltf', res_obj)
    gltf_url = entry.get('url')
    if not gltf_url:
        print(f"Could not find gltf URL for {asset_id}")
        return False

    target_dir = os.path.join(MODELS_DIR, asset_id)
    os.makedirs(target_dir, exist_ok=True)
    gltf_path = os.path.join(target_dir, f"{asset_id}_{res}.gltf")

    print(f"Downloading {asset_id} ({res}) from {gltf_url}...")
    urllib.request.urlretrieve(gltf_url, gltf_path)

    # Download required texture payloads & bin file
    includes = entry.get('include', {})
    for sub_rel_path, sub_info in includes.items():
        sub_url = sub_info.get('url') if isinstance(sub_info, dict) else sub_info
        if sub_url:
            sub_file_path = os.path.join(target_dir, sub_rel_path)
            os.makedirs(os.path.dirname(sub_file_path), exist_ok=True)
            print(f"  Fetching payload: {sub_rel_path}...")
            urllib.request.urlretrieve(sub_url, sub_file_path)

    print(f"Successfully downloaded {asset_id} to {target_dir}")
    return True

if __name__ == '__main__':
    for asset_id in TARGETS:
        fetch_asset(asset_id, '1k')

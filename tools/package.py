"""打包运行时文件并校验内容，使用标准 ZIP 路径，不包含问卷夹具。"""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8-sig'))
files = [root / 'manifest.json']
for directory in ('content', 'popup', 'options', 'icons'):
    files.extend(sorted(path for path in (root / directory).rglob('*') if path.is_file()))
output = root / 'dist' / 'ustc-grade-helper.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for path in files:
        archive.write(path, path.relative_to(root).as_posix())
with ZipFile(output) as archive:
    assert archive.testzip() is None
    assert 'manifest.json' in archive.namelist()
    assert len(archive.namelist()) == len(files)
    for path in files:
        assert archive.read(path.relative_to(root).as_posix()) == path.read_bytes()
    assert json.loads(archive.read('manifest.json')) == manifest
print(f'Package: {output}')
print(f'Version: {manifest["version"]}; files: {len(files)}; verified')
print(f'SHA256: {hashlib.sha256(output.read_bytes()).hexdigest()}')

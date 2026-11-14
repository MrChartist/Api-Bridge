"""Download history in the background on the Bridge, keep it as files, and read it back.

    python download_save.py [FOLDER]

The job runs at the lowest priority, so it never slows live reads or orders. Every file says its data class (realtime,
delayed or eod) in the manifest.json written next to it.
"""

import sys

from mrchartist_bridge import Bridge, DownloadFailed

folder = sys.argv[1] if len(sys.argv) > 1 else "data"
bridge = Bridge()

job = bridge.downloads.create(["NSE:RELIANCE", "NSE:TCS"], "5m", from_="2024-01-01", dataset="large-caps-5m")
print("queued", job.id, "-", job.label)
try:
    job = bridge.downloads.wait(job, on_progress=lambda j: print("  %s %d/%d items, %d rows" % (j.status, j.progress.done, j.progress.total, j.progress.rows)))
except DownloadFailed as e:
    sys.exit("stopped: %s" % e)

for f in bridge.downloads.save(job, folder):
    print(("kept " if f.skipped else "saved"), f.path, f.bytes, "bytes", f.sha256[:12])

rows = bridge.downloads.read(job)
print(len(rows), "rows; first:", rows[0])

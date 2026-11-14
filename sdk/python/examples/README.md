# Examples

Each script is short and runs against a demo Bridge (sample prices, paper orders only):

```
mc-bridge start --demo                                   # one terminal
mc-bridge keys create --label py --scope read,paper,admin
export MCB_API_KEY=mcb_...  MCB_ACCOUNT=demo-paper       # or: python -m mrchartist_bridge login
python sdk/python/examples/prices.py
```

| Script | Shows |
|---|---|
| `prices.py` | last prices and quotes, with the freshness label of every number |
| `paper_order.py` | a paper order with a generated idempotency key, `wait_for_fill`, then flatten with `to_target` |
| `stream_reconnect.py` | a live stream that reconnects by itself, typed events, gap and conflation counters |
| `history_dataframe.py` | candles as a pandas DataFrame with an IST index (needs the `[pandas]` extra) |
| `sources_freshness.py` | where data comes from, and what `require_realtime()` refuses |
| `ticket_wait.py` | waiting for a person to approve an order on the Bridge's computer (the script cannot approve) |
| `download_save.py` | a background download job: progress, saving the files with a checksum check, reading them back |
| `collections_and_datasets.py` | a named list, an option universe that follows ATM and the weekly expiry, a dataset updated incrementally |
| `record_chains.py` | recording option chains by hand and with a rule that runs every trading day |
| `events_listen.py` | listening to Bridge events with reconnect, continuing from a saved cursor |
| `webhook_receiver.py` | a small receiver that verifies the Bridge's webhook signature |
| `history_all.py` | candles over a long range, local-first, with the label and optional Parquet |

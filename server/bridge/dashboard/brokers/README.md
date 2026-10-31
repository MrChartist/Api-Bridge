# Broker logos

One 64 x 64 PNG per broker id (`<id>.png`), shown on the dashboard's Accounts page so each broker is easy to recognise.
The Bridge serves them itself as `/dashboard/broker-<id>.png` (the dashboard never loads images from other sites).

They are the icons each broker publishes for its own website (its favicon or app icon), taken from the broker's
official site and re-encoded here as small PNGs. The logos and names are trademarks of their owners and are used only
to identify each broker; this project is not affiliated with or endorsed by any of them. A broker that would rather
not appear with its logo can open an issue and we will switch it back to initials.

To add a logo for a new broker: save its official site icon as a square PNG named `<id>.png` (64 x 64, transparent
corners where the icon has them). Without a file the dashboard shows the broker's initials.

Blackmagic Design licensed files are intentionally not included in this repository.

Before running scripts/30-install-blackmagic.sh, download both Linux packages
from the official support page and place the original archives in this folder:

https://www.blackmagicdesign.com/support/

Required content:
1. Blackmagic Desktop Video for Linux (driver and userspace packages).
2. Blackmagic Desktop Video SDK for Linux (must contain DeckLinkAPI.h).

Use vendor-supported versions for the target Ubuntu kernel and card, and review
and accept the vendor license yourself. The repository does not mirror or
redistribute these files.

Do not rename or unpack the downloads manually. The installer validates archive
paths, extracts into /var/lib/streamhub-install, installs amd64/all .deb files,
and copies only the SDK include directory to a stable local path.

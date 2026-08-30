include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI system disk image backup
LUCI_DESCRIPTION:=Create a restorable raw image of the active OpenWrt system disk on a mounted USB device
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-sysdiskbackup
PKG_VERSION:=1.2.0
PKG_RELEASE:=5
PKG_LICENSE:=GPL-3.0-or-later
PKG_LICENSE_FILES:=LICENSE

define Build/Prepare/luci-app-sysdiskbackup
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/luci-disk-backup
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/luci-gpt-relocate.uc
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature

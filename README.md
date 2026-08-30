# luci-app-sysdiskbackup

Paquet LuCI pour OpenWrt 25.12 et versions ultérieures utilisant `apk`. Il crée,
à la racine d’un stockage USB monté, une image brute restaurable du disque
système actif.

## Fonctions

- détection du disque physique qui porte `/rom`, `/overlay` et `/` ;
- association automatique des volumes virtuels OpenWrt `fit0` et `fitrw` à
  leur support physique grâce au `rootdisk` du Device Tree ;
- choix manuel du disque source dans LuCI si l’association automatique reste
  impossible, avec une saisie libre du nom du disque si l’énumération ne
  retourne aucune proposition ;
- mode automatique recommandé et possibilité permanente de forcer un disque
  source physique depuis LuCI ;
- refus si le système actif s’étend sur plusieurs disques ;
- détection des destinations par leur véritable chemin matériel USB dans
  `/sys`, pas uniquement par leur nom `/dev/sdX` ;
- refus du disque source comme destination ;
- vérification du montage en lecture-écriture et de l’espace libre, avec une
  marge de sécurité de 16 Mio ;
- découpage automatique sur FAT32 en fichiers de 2 Gio, accompagné de scripts
  Windows et Linux/macOS permettant de reconstituer l’image brute sans
  reformater ni écraser les fichiers déjà présents ;
- copie des secteurs d’amorçage et des partitions jusqu’à la fin de la dernière
  partition, sans copier l’espace non partitionné restant ;
- conservation d’une marge de 1 Mio et reconstruction autonome de l’en-tête
  GPT de secours lorsque l’image est raccourcie, sans dépendance à `sgdisk` ;
- progression globale, pourcentage, temps écoulé, temps restant estimé, débit
  d’écriture, annulation et état depuis LuCI ;
- création d’un fichier `.sha256` à côté de l’image `.img`.

## Limites importantes

Une image brute faite pendant que le système écrit sur son disque est
« cohérente après incident », mais ce n’est pas un instantané atomique. Le
script appelle `sync` avant la copie ; il est néanmoins recommandé d’éviter
tout changement de configuration pendant l’opération. Pour une garantie
maximale, démarrer un système de secours et cloner le disque démonté.

Les stockages NAND bruts, MTD, UBI/UBIFS, les ensembles RAID, les volumes
device-mapper complexes et les systèmes répartis sur plusieurs disques sont
refusés : un fichier `.img` écrit par Rufus ou Balena Etcher n’est pas un moyen
de restauration fiable pour ces organisations.

Les disques à secteurs logiques natifs de 4 Kio sont également refusés. Une
image brute n’encode pas la taille logique des secteurs et ne peut donc pas être
garantie portable vers un support classique à secteurs logiques de 512 octets.

« Dernier secteur utilisé » signifie ici la fin de la dernière partition utile.
Réduire jusqu’au dernier bloc de fichier réellement alloué nécessiterait de
réduire le système de fichiers et la partition hors ligne ; tronquer simplement
à ce bloc produirait une image corrompue ou non portable.

## Construction avec le SDK OpenWrt 25.12+

Placer ce dossier dans un feed ou dans `package/luci-app-sysdiskbackup`, puis :

```sh
./scripts/feeds update -a
./scripts/feeds install -a
make menuconfig
make package/luci-app-sysdiskbackup/compile V=s
```

Le paquet généré porte l’extension `.apk`. Il est indépendant de l’architecture
(`noarch` dans les APK OpenWrt 25+) et convient notamment aux cartes SD et à
l’eMMC (`mmcblk`) du Banana Pi R3, y compris son agencement FIT OpenWrt 25.
Sur le routeur :

```sh
apk add --allow-untrusted ./luci-app-sysdiskbackup-*.apk
# Facultatif si LuCI est utilisé en français :
apk add --allow-untrusted ./luci-i18n-sysdiskbackup-fr-*.apk
/etc/init.d/rpcd restart
```

Ouvrir ensuite **Système → Image système**. Le périphérique USB doit déjà être
monté en lecture-écriture, par exemple depuis **Système → Points de montage**.

## Restauration

Pour une sauvegarde découpée sur FAT32 sous Windows, copier le fichier
`*-merge-windows.cmd` et toutes les parties `*.partNNN` dans un même dossier sur
un disque NTFS ou exFAT, puis double-cliquer sur le script. L’image `.img` est
créée automatiquement dans ce dossier. Le script reste ouvert, vérifie la
présence de toutes les parties, refuse d’écraser un fichier existant et affiche
le SHA-256 à comparer. Il contrôle aussi le système de fichiers et l’espace libre
avant de commencer ; sur FAT32, il demande de copier le script et les morceaux
vers un dossier NTFS ou exFAT.

Sur macOS, copier le fichier `*-merge-macos.command` et toutes les parties
`*.partNNN` dans un même dossier APFS, HFS+ ou exFAT, puis double-cliquer sur le
fichier `.command`. Le script bloque également FAT32 avant toute copie, crée
l’image dans son propre dossier et vérifie automatiquement son SHA-256.

Vérifier d’abord le fichier d’intégrité :

```sh
sha256sum -c openwrt-*.img.sha256
```

Écrire ensuite le fichier `.img` avec Balena Etcher, Rufus en mode image DD, ou
`dd`. Le support cible doit être au moins aussi grand que le fichier image. Au
premier démarrage, agrandir la dernière partition et son système de fichiers si
l’on souhaite utiliser tout l’espace supplémentaire du nouveau support.

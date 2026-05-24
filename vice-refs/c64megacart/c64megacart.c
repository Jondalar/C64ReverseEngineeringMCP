/*
 * c64megacart.c - Cartridge handling, C64MegaCart cart.
 *
 * Written by
 *  Martin Piper for C64MegaCart tweaks from GMod2 implementation
 *  Previous GMod2 implementation groepaz <groepaz@gmx.net>
 *
 * This file is part of VICE, the Versatile Commodore Emulator.
 * See README for copyright notice.
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program; if not, write to the Free Software
 *  Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA
 *  02111-1307  USA.
 *
 */

#include "vice.h"

#include <stdio.h>
#include <string.h>

#include "archdep.h"
#include "c64cart.h"
#define CARTRIDGE_INCLUDE_SLOTMAIN_API
#include "c64cartsystem.h"
#undef CARTRIDGE_INCLUDE_SLOTMAIN_API
#include "c64mem.h"
#include "cartio.h"
#include "cartridge.h"
#include "cmdline.h"
#include "crt.h"
#include "export.h"
#include "flash040.h"
#include "lib.h"
#include "maincpu.h"
#include "monitor.h"
#include "resources.h"
#include "m93c86.h"
#include "translate.h"
#include "snapshot.h"
#include "types.h"
#include "util.h"
#include "vicii-phi1.h"

#define CARTRIDGE_INCLUDE_PRIVATE_API
#include "c64megacart.h"
#undef CARTRIDGE_INCLUDE_PRIVATE_API

/*
    C64MegaCart (Replica Software http://www.replicasoftware.com/ )

    8KB to 128MB (Up to 256 * 64 * 8KB pages) Flash ROM (equivalent 29F040)

    io1
        - register at de00 (mirrored over IO1 bank)
		8KB Bank select low (ro) (bank bits 0-7)

	io2
		- register at df00 (mirrored over IO2 bank)

        bit7   (ro)  Cart kill (maps directly to _EXROM)
        bit6   (ro)  Flash write	(bit6 | bit7 and PHI2 and $E000 and write = Flash write command)
        bit5-0 (ro)  High bank select (bank bits 8-13)

    see http://wiki.icomp.de/wiki/C64MegaCart
*/

/* #define DEBUGC64MEGACART */

#ifdef DEBUGC64MEGACART
#define DBG(x)  printf x
#else
#define DBG(x)
#endif

#define C64MEGACART_FLASH_SIZE (2048*1024)

static size_t c64megacart_size = C64MEGACART_FLASH_SIZE;

static int c64megacart_enabled = 0;

/* current GAME/EXROM mode */
static int c64megacart_cmode = CMODE_8KGAME;
static int c64megacart_cmodeVIC = CMODE_8KGAME;

/* current bank */
static int c64megacart_bank = 0;
static int c64megacart_flash_write = 0;

/* the 29F010 statemachine */
static flash040_context_t *flashrom_state = NULL;

static char *c64megacart_filename = NULL;
static int c64megacart_filetype = 0;

static const char STRING_C64MEGACART[] = CARTRIDGE_NAME_C64MEGACART;

/* ---------------------------------------------------------------------*/

/* some prototypes are needed */
static BYTE c64megacart_io1_read(WORD addr);
static BYTE c64megacart_io1_peek(WORD addr);
static void c64megacart_io1_store(WORD addr, BYTE value);
static BYTE c64megacart_io2_read(WORD addr);
static BYTE c64megacart_io2_peek(WORD addr);
static void c64megacart_io2_store(WORD addr, BYTE value);
static int c64megacart_dump(void);


static io_source_t c64megacart_io1_device = {
    CARTRIDGE_NAME_C64MEGACART,
    IO_DETACH_CART,
    NULL,
    0xde00, 0xdeff, 0xff,
    0,
    c64megacart_io1_store,
    c64megacart_io1_read,
    c64megacart_io1_peek,
    c64megacart_dump,
    CARTRIDGE_C64MEGACART,
    1,
    0
};
static io_source_list_t *c64megacart_io1_list_item = NULL;

static io_source_t c64megacart_io2_device = {
	CARTRIDGE_NAME_C64MEGACART,
	IO_DETACH_CART,
	NULL,
	0xdf00, 0xdfff, 0xff,
	0,
	c64megacart_io2_store,
	c64megacart_io2_read,
	c64megacart_io2_peek,
	c64megacart_dump,
	CARTRIDGE_C64MEGACART,
	1,
	0
};
static io_source_list_t *c64megacart_io2_list_item = NULL;

static const export_resource_t export_res = {
    CARTRIDGE_NAME_C64MEGACART, 1, 1, &c64megacart_io1_device, &c64megacart_io2_device, CARTRIDGE_C64MEGACART
};

/* ---------------------------------------------------------------------*/

BYTE c64megacart_io1_read(WORD addr)
{
    c64megacart_io1_device.io_source_valid = 0;

    return (vicii_read_phi1() & 0xff);
}

BYTE c64megacart_io1_peek(WORD addr)
{
    return (vicii_read_phi1() & 0xff);
}

void c64megacart_io1_store(WORD addr, BYTE value)
{
    DBG(("io1 w %04x %02x (cs:%d data:%d clock:%d)\n", addr, value, (value >> 6) & 1, (value >> 4) & 1, (value >> 5) & 1));

    c64megacart_bank = (c64megacart_bank & 0xff00) | value;
	cart_romlbank_set_slotmain(c64megacart_bank);
}

BYTE c64megacart_io2_read(WORD addr)
{
	c64megacart_io2_device.io_source_valid = 0;

	return (vicii_read_phi1() & 0xff);
}

BYTE c64megacart_io2_peek(WORD addr)
{
	return (vicii_read_phi1() & 0xff);
}

void c64megacart_io2_store(WORD addr, BYTE value)
{
	int mode = CMODE_WRITE;

	DBG(("io2 w %04x %02x (cs:%d data:%d clock:%d)\n", addr, value, (value >> 6) & 1, (value >> 4) & 1, (value >> 5) & 1));

	c64megacart_bank = (c64megacart_bank & 0x00ff) | (((int)(value & 0x3f)) << 8);
	if ((value & 0xc0) == 0xc0) {
		/* FIXME: flash mode enable, ultimax for e000-ffff */
		c64megacart_cmode = CMODE_ULTIMAX;
	}
	else if ((value & 0xc0) == 0x00) {
		c64megacart_cmode = CMODE_8KGAME;
	}
	else if ((value & 0xc0) == 0x80) {
		c64megacart_cmode = CMODE_RAM;
	}
	if ((value & 0x80) == 0x00) {
		c64megacart_cmodeVIC = CMODE_8KGAME;
	}
	else {
		c64megacart_cmodeVIC = CMODE_RAM;
	}
	cart_config_changed_slotmain((BYTE)(c64megacart_cmodeVIC), (BYTE)(c64megacart_cmode), mode);
	cart_romlbank_set_slotmain(c64megacart_bank);
}

/* ---------------------------------------------------------------------*/

BYTE c64megacart_roml_read(WORD addr)
{
    return flash040core_read(flashrom_state, (addr & 0x1fff) + (roml_bank << 13));
}

void c64megacart_romh_store(WORD addr, BYTE value)
{
    flash040core_store(flashrom_state, (addr & 0x1fff) + (roml_bank << 13), value);
    if (flashrom_state->flash_state != FLASH040_STATE_READ) {
        maincpu_resync_limits();
    }
}

int c64megacart_peek_mem(export_t *export, WORD addr, BYTE *value)
{
    if (addr >= 0x8000 && addr <= 0x9fff) {
        *value = c64megacart_roml_read(addr);
        return CART_READ_VALID;
    }
    return CART_READ_THROUGH;
}

void c64megacart_mmu_translate(unsigned int addr, BYTE **base, int *start, int *limit)
{
#if 0
    if (flashrom_state && flashrom_state->flash_data) {
        switch (addr & 0xe000) {
            case 0xe000:
                if (flashrom_state->flash_state == FLASH040_STATE_READ) {
                    *base = flashrom_state->flash_data + (roml_bank << 13) - 0xe000;
                    *start = 0xe000;
                    *limit = 0xfffd;
                    return;
                }
                break;
            case 0x8000:
                if (flashrom_state->flash_state == FLASH040_STATE_READ) {
                    *base = flashrom_state->flash_data + (roml_bank << 13) - 0x8000;
                    *start = 0x8000;
                    *limit = 0x9ffd;
                    return;
                }
                break;
            default:
                break;
        }
    }
#endif
    *base = NULL;
    *start = 0;
    *limit = 0;
}

/* ---------------------------------------------------------------------*/

static int c64megacart_dump(void)
{
    /* FIXME: incomplete */
    mon_out("GAME/EXROM status: %s%s\n", 
            cart_config_string(c64megacart_cmodeVIC),
            (c64megacart_cmode == CMODE_ULTIMAX) ? " (Flash mode)" : "");
    mon_out("ROM bank: %d\n", c64megacart_bank);

    return 0;
}

/* ---------------------------------------------------------------------*/

void c64megacart_config_init(void)
{
	c64megacart_bank = 0;
    c64megacart_cmode = CMODE_8KGAME;
	c64megacart_cmodeVIC = CMODE_8KGAME;
    cart_config_changed_slotmain((BYTE)c64megacart_cmodeVIC, (BYTE)c64megacart_cmode, CMODE_READ);
    flash040core_reset(flashrom_state);
}

void c64megacart_reset(void)
{
	c64megacart_bank = 0;
	c64megacart_cmode = CMODE_8KGAME;
	c64megacart_cmodeVIC = CMODE_8KGAME;
    cart_config_changed_slotmain((BYTE)c64megacart_cmodeVIC, (BYTE)c64megacart_cmode, CMODE_READ);

    /* on the real hardware pressing reset would NOT reset the flash statemachine,
       only a powercycle would help. we do it here anyway :)
    */
    flash040core_reset(flashrom_state);
}

void c64megacart_config_setup(BYTE *rawcart)
{
	c64megacart_bank = 0;
	c64megacart_cmode = CMODE_8KGAME;
	c64megacart_cmodeVIC = CMODE_8KGAME;
    cart_config_changed_slotmain((BYTE)c64megacart_cmodeVIC, (BYTE)c64megacart_cmode, CMODE_READ);

    flashrom_state = lib_malloc(sizeof(flash040_context_t));
    flash040core_init(flashrom_state, maincpu_alarm_context, FLASH040_TYPE_160, roml_banks);
    memcpy(flashrom_state->flash_data, rawcart, c64megacart_size);
}

/* ---------------------------------------------------------------------*/

static int set_c64megacart_flash_write(int val, void *param)
{
    c64megacart_flash_write = val ? 1 : 0;

    return 0;
}

static const resource_string_t resources_string[] = {
    RESOURCE_STRING_LIST_END
};

static const resource_int_t resources_int[] = {
    { "C64MegaCartFlashWrite", 0, RES_EVENT_NO, NULL,
      &c64megacart_flash_write, set_c64megacart_flash_write, NULL },
    RESOURCE_INT_LIST_END
};

int c64megacart_resources_init(void)
{
    if (resources_register_string(resources_string) < 0) {
        return -1;
    }
    return resources_register_int(resources_int);
}

void c64megacart_resources_shutdown(void)
{
}

/* ------------------------------------------------------------------------- */

static const cmdline_option_t cmdline_options[] =
{
    { "-c64megacartflashwrite", SET_RESOURCE, 0,
      NULL, NULL, "C64MegaCartFlashWrite", (resource_value_t)1,
      USE_PARAM_STRING, USE_DESCRIPTION_ID,
      IDCLS_UNUSED, IDCLS_ENABLE_SAVE_C64MEGACART_ROM_AT_EXIT,
      NULL, NULL },
    { "+c64megacartflashwrite", SET_RESOURCE, 0,
      NULL, NULL, "C64MegaCartFlashWrite", (resource_value_t)0,
      USE_PARAM_STRING, USE_DESCRIPTION_ID,
      IDCLS_UNUSED, IDCLS_DISABLE_SAVE_C64MEGACART_ROM_AT_EXIT,
      NULL, NULL },
    CMDLINE_LIST_END
};

int c64megacart_cmdline_options_init(void)
{
    return cmdline_register_options(cmdline_options);
}

static int c64megacart_common_attach(void)
{
    if (export_add(&export_res) < 0) {
        return -1;
    }

    c64megacart_io1_list_item = io_source_register(&c64megacart_io1_device);
    c64megacart_io2_list_item = io_source_register(&c64megacart_io2_device);

    c64megacart_enabled = 1;

    return 0;
}

int c64megacart_bin_attach(const char *filename, BYTE *rawcart)
{
    c64megacart_filetype = 0;
    c64megacart_filename = NULL;

	FILE *fp = fopen(filename , "rb");
	if (!fp)
	{
		return -1;
	}
	c64megacart_size = util_file_length(fp);
	fclose(fp);

    if (util_file_load(filename, rawcart, c64megacart_size, UTIL_FILE_LOAD_SKIP_ADDRESS | UTIL_FILE_LOAD_FILL) < 0) {
        return -1;
    }

    c64megacart_filetype = CARTRIDGE_FILETYPE_BIN;
    c64megacart_filename = lib_stralloc(filename);
    return c64megacart_common_attach();
}

int c64megacart_crt_attach(FILE *fd, BYTE *rawcart, const char *filename)
{
    crt_chip_header_t chip;
    int i;

    memset(rawcart, 0xff, c64megacart_size);

    c64megacart_filetype = 0;
    c64megacart_filename = NULL;

    for (i = 0; i <= 255; i++) {
        if (crt_read_chip_header(&chip, fd)) {
            break;
        }

        if (chip.bank > 255 || chip.size != 0x2000) {
            return -1;
        }

        if (crt_read_chip(rawcart, chip.bank << 13, &chip, fd)) {
            return -1;
        }
    }

    c64megacart_filetype = CARTRIDGE_FILETYPE_CRT;
    c64megacart_filename = lib_stralloc(filename);

    return c64megacart_common_attach();
}

int c64megacart_bin_save(const char *filename)
{
    FILE *fd;

    if (filename == NULL) {
        return -1;
    }

    fd = fopen(filename, MODE_WRITE);

    if (fd == NULL) {
        return -1;
    }

    if (fwrite(roml_banks, 1, c64megacart_size, fd) != c64megacart_size) {
        fclose(fd);
        return -1;
    }

    fclose(fd);

    return 0;
}

int c64megacart_crt_save(const char *filename)
{
    FILE *fd;
    crt_chip_header_t chip;
    BYTE *data;
    int i;

    fd = crt_create(filename, CARTRIDGE_C64MEGACART, 1, 0, STRING_C64MEGACART);

    if (fd == NULL) {
        return -1;
    }

    chip.type = 2;
    chip.size = 0x2000;
    chip.start = 0x8000;

    data = &roml_banks[0x10000];

    for (i = 0; i < 64; i++) {
        chip.bank = i; /* bank */

        if (crt_write_chip(data, &chip, fd)) {
            fclose(fd);
            return -1;
        }
        data += 0x2000;
    }

    fclose(fd);
    return 0;
}

int c64megacart_flush_image(void)
{
    if (c64megacart_filetype == CARTRIDGE_FILETYPE_BIN) {
        return c64megacart_bin_save(c64megacart_filename);
    } else if (c64megacart_filetype == CARTRIDGE_FILETYPE_CRT) {
        return c64megacart_crt_save(c64megacart_filename);
    }
    return -1;
}

void c64megacart_detach(void)
{
    if (c64megacart_flash_write && flashrom_state->flash_dirty) {
        c64megacart_flush_image();
    }

    flash040core_shutdown(flashrom_state);
    lib_free(flashrom_state);
    flashrom_state = NULL;
    lib_free(c64megacart_filename);
    c64megacart_filename = NULL;
    export_remove(&export_res);
    io_source_unregister(c64megacart_io1_list_item);
    c64megacart_io1_list_item = NULL;
	io_source_unregister(c64megacart_io2_list_item);
	c64megacart_io2_list_item = NULL;

    c64megacart_enabled = 0;
}

/* ---------------------------------------------------------------------*/

static char snap_module_name[] = "CARTC64MEGACART";
static char flash_snap_module_name[] = "FLASH040C64MEGACART";
#define SNAP_MAJOR   0
#define SNAP_MINOR   1

int c64megacart_snapshot_write_module(snapshot_t *s)
{
    snapshot_module_t *m;

    m = snapshot_module_create(s, snap_module_name, SNAP_MAJOR, SNAP_MINOR);

    if (m == NULL) {
        return -1;
    }

    if (0
        || SMW_B(m, (BYTE)c64megacart_cmode) < 0
        || SMW_B(m, (BYTE)c64megacart_bank) < 0) {
        snapshot_module_close(m);
        return -1;
    }

    snapshot_module_close(m);

    return flash040core_snapshot_write_module(s, flashrom_state, flash_snap_module_name);
}

int c64megacart_snapshot_read_module(snapshot_t *s)
{
    BYTE vmajor, vminor;
    snapshot_module_t *m;

    m = snapshot_module_open(s, snap_module_name, &vmajor, &vminor);

    if (m == NULL) {
        return -1;
    }

    /* Do not accept versions higher than current */
    if (vmajor > SNAP_MAJOR || vminor > SNAP_MINOR) {
        snapshot_set_error(SNAPSHOT_MODULE_HIGHER_VERSION);
        goto fail;
    }

    if (0
        || SMR_B_INT(m, &c64megacart_cmode) < 0
        || SMR_B_INT(m, &c64megacart_bank) < 0) {
        goto fail;
    }

    snapshot_module_close(m);

    flashrom_state = lib_malloc(sizeof(flash040_context_t));
    flash040core_init(flashrom_state, maincpu_alarm_context, FLASH040_TYPE_NORMAL, roml_banks);

    if (flash040core_snapshot_read_module(s, flashrom_state, flash_snap_module_name) < 0) {
        flash040core_shutdown(flashrom_state);
        lib_free(flashrom_state);
        flashrom_state = NULL;
        return -1;
    }

    c64megacart_common_attach();

    /* set filetype to none */
    c64megacart_filename = NULL;
    c64megacart_filetype = 0;

    return 0;

fail:
    snapshot_module_close(m);
    return -1;
}

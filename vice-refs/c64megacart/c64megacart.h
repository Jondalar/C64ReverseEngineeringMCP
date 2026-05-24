/*
 * c64megacart.h - Cartridge handling, C64MegaCart cart.
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
 
#ifndef CARTRIDGE_INCLUDE_PRIVATE_API
#ifndef CARTRIDGE_INCLUDE_PUBLIC_API
#error "do not include this header directly, use c64cart.h instead."
#endif
#endif

#ifndef VICE_C64MEGACART_H
#define VICE_C64MEGACART_H

#include <stdio.h>

#include "types.h"

struct snapshot_s;

extern BYTE c64megacart_roml_read(WORD addr);
extern void c64megacart_romh_store(WORD addr, BYTE value);

extern int c64megacart_peek_mem(export_t *export, WORD addr, BYTE *value);
extern void c64megacart_mmu_translate(unsigned int addr, BYTE **base, int *start, int *limit);

extern void c64megacart_config_init(void);
extern void c64megacart_reset(void);
extern void c64megacart_config_setup(BYTE *rawcart);
extern int c64megacart_bin_attach(const char *filename, BYTE *rawcart);
extern int c64megacart_crt_attach(FILE *fd, BYTE *rawcart, const char *filename);
extern int c64megacart_bin_save(const char *filename);
extern int c64megacart_crt_save(const char *filename);
extern int c64megacart_flush_image(void);
extern void c64megacart_detach(void);

extern int c64megacart_cmdline_options_init(void);
extern int c64megacart_resources_init(void);
extern void c64megacart_resources_shutdown(void);

extern int c64megacart_snapshot_write_module(struct snapshot_s *s);
extern int c64megacart_snapshot_read_module(struct snapshot_s *s);

#endif

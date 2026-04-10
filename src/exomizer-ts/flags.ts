/*
 * Direct port of src/flags.h constants from Exomizer 3.1.2.
 */

export const PBIT_BITS_ORDER_BE = 0;
export const PBIT_BITS_COPY_GT_7 = 1;
export const PBIT_IMPL_1LITERAL = 2;
export const PBIT_BITS_ALIGN_START = 3;
export const PBIT_4_OFFSET_TABLES = 4;
export const PBIT_REUSE_OFFSET = 5;

export const PFLAG_BITS_ORDER_BE = 1 << PBIT_BITS_ORDER_BE;
export const PFLAG_BITS_COPY_GT_7 = 1 << PBIT_BITS_COPY_GT_7;
export const PFLAG_IMPL_1LITERAL = 1 << PBIT_IMPL_1LITERAL;
export const PFLAG_BITS_ALIGN_START = 1 << PBIT_BITS_ALIGN_START;
export const PFLAG_4_OFFSET_TABLES = 1 << PBIT_4_OFFSET_TABLES;
export const PFLAG_REUSE_OFFSET = 1 << PBIT_REUSE_OFFSET;

export const TBIT_LIT_SEQ = 0;
export const TBIT_LEN1_SEQ = 1;
export const TBIT_LEN0123_SEQ_MIRRORS = 2;

export const TFLAG_LIT_SEQ = 1 << TBIT_LIT_SEQ;
export const TFLAG_LEN1_SEQ = 1 << TBIT_LEN1_SEQ;
export const TFLAG_LEN0123_SEQ_MIRRORS = 1 << TBIT_LEN0123_SEQ_MIRRORS;

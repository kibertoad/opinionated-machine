import { describe, expect, it } from 'vitest'
import {
  determineMode,
  determineSyncFormat,
  hasHttpStatusCode,
  isErrorLike,
} from './fastifyRouteUtils.ts'

describe('fastifyRouteUtils', () => {
  describe('isErrorLike', () => {
    it('returns true for Error objects', () => {
      expect(isErrorLike(new Error('test'))).toBe(true)
    })

    it('returns true for objects with message property', () => {
      expect(isErrorLike({ message: 'test' })).toBe(true)
    })

    it('returns false for null', () => {
      expect(isErrorLike(null)).toBe(false)
    })

    it('returns false for undefined', () => {
      expect(isErrorLike(undefined)).toBe(false)
    })

    it('returns false for strings', () => {
      expect(isErrorLike('error')).toBe(false)
    })

    it('returns false for objects without message property', () => {
      expect(isErrorLike({ error: 'test' })).toBe(false)
    })

    it('returns false for objects with non-string message property', () => {
      expect(isErrorLike({ message: 123 })).toBe(false)
    })
  })

  describe('hasHttpStatusCode', () => {
    it('returns true for objects with numeric httpStatusCode', () => {
      expect(hasHttpStatusCode({ httpStatusCode: 404 })).toBe(true)
    })

    it('returns true for Error-like objects with httpStatusCode', () => {
      expect(hasHttpStatusCode({ message: 'test', httpStatusCode: 500 })).toBe(true)
    })

    it('returns false for null', () => {
      expect(hasHttpStatusCode(null)).toBe(false)
    })

    it('returns false for undefined', () => {
      expect(hasHttpStatusCode(undefined)).toBe(false)
    })

    it('returns false for strings', () => {
      expect(hasHttpStatusCode('error')).toBe(false)
    })

    it('returns false for objects without httpStatusCode property', () => {
      expect(hasHttpStatusCode({ message: 'test' })).toBe(false)
    })

    it('returns false for objects with non-number httpStatusCode property', () => {
      expect(hasHttpStatusCode({ httpStatusCode: '404' })).toBe(false)
    })
  })

  describe('determineMode', () => {
    it('returns default mode when accept is undefined', () => {
      expect(determineMode(undefined)).toBe('json')
      expect(determineMode(undefined, 'sse')).toBe('sse')
    })

    it('returns sse mode for text/event-stream', () => {
      expect(determineMode('text/event-stream')).toBe('sse')
    })

    it('returns json mode for application/json', () => {
      expect(determineMode('application/json')).toBe('json')
    })

    it('returns default mode for */*', () => {
      expect(determineMode('*/*')).toBe('json')
      expect(determineMode('*/*', 'sse')).toBe('sse')
    })

    it('handles quality values correctly', () => {
      // text/event-stream has higher quality
      expect(determineMode('application/json;q=0.5, text/event-stream;q=0.9')).toBe('sse')

      // application/json has higher quality
      expect(determineMode('text/event-stream;q=0.5, application/json;q=0.9')).toBe('json')
    })

    it('filters out rejected types (quality = 0)', () => {
      expect(determineMode('text/event-stream;q=0, application/json')).toBe('json')
    })

    it('returns default mode for unrecognized types', () => {
      expect(determineMode('text/html')).toBe('json')
      expect(determineMode('text/html', 'sse')).toBe('sse')
    })
  })

  describe('determineSyncFormat', () => {
    const supportedFormats = ['application/json', 'text/plain', 'text/csv']

    it('returns default format when accept is undefined', () => {
      const result = determineSyncFormat(undefined, supportedFormats)
      expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
    })

    it('returns specified default format when accept is undefined', () => {
      const result = determineSyncFormat(undefined, supportedFormats, 'text/plain')
      expect(result).toEqual({ mode: 'sync', contentType: 'text/plain' })
    })

    it('returns sse mode for text/event-stream', () => {
      const result = determineSyncFormat('text/event-stream', supportedFormats)
      expect(result).toEqual({ mode: 'sse' })
    })

    it('returns matching format from accept header', () => {
      expect(determineSyncFormat('application/json', supportedFormats)).toEqual({
        mode: 'sync',
        contentType: 'application/json',
      })

      expect(determineSyncFormat('text/plain', supportedFormats)).toEqual({
        mode: 'sync',
        contentType: 'text/plain',
      })

      expect(determineSyncFormat('text/csv', supportedFormats)).toEqual({
        mode: 'sync',
        contentType: 'text/csv',
      })
    })

    it('handles quality value negotiation', () => {
      // text/csv has highest quality
      const result = determineSyncFormat(
        'application/json;q=0.5, text/plain;q=0.8, text/csv;q=0.9',
        supportedFormats,
      )
      expect(result).toEqual({ mode: 'sync', contentType: 'text/csv' })
    })

    it('prefers SSE over other formats when SSE has highest quality', () => {
      const result = determineSyncFormat(
        'application/json;q=0.5, text/event-stream;q=0.9',
        supportedFormats,
      )
      expect(result).toEqual({ mode: 'sse' })
    })

    it('uses default format for */*', () => {
      const result = determineSyncFormat('*/*', supportedFormats)
      expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
    })

    it('uses specified default format for */*', () => {
      const result = determineSyncFormat('*/*', supportedFormats, 'text/csv')
      expect(result).toEqual({ mode: 'sync', contentType: 'text/csv' })
    })

    it('returns default format when no accept matches', () => {
      // text/xml is not in supported formats
      const result = determineSyncFormat('text/xml', supportedFormats)
      expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
    })

    it('returns default format when only unsupported formats are requested', () => {
      const result = determineSyncFormat('text/html, text/xml', supportedFormats)
      expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
    })

    it('filters out rejected types (quality = 0)', () => {
      const result = determineSyncFormat(
        'text/event-stream;q=0, application/json',
        supportedFormats,
      )
      expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
    })

    it('handles empty supported formats array', () => {
      const result = determineSyncFormat('application/json', [])
      expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
    })

    it('handles case-insensitive media types', () => {
      const result = determineSyncFormat('APPLICATION/JSON', supportedFormats)
      expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
    })

    it('handles parameters without values', () => {
      // Parameters without '=' should be ignored
      const result = determineSyncFormat('application/json;charset', supportedFormats)
      expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
    })

    it('handles non-q parameters', () => {
      // Non-q parameters should be ignored
      const result = determineSyncFormat('application/json;charset=utf-8', supportedFormats)
      expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
    })

    it('handles multiple parameters including q', () => {
      // Multiple parameters, including q
      const result = determineSyncFormat(
        'text/plain;charset=utf-8;q=0.5, application/json;q=0.9',
        supportedFormats,
      )
      expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
    })

    describe('subtype wildcard matching', () => {
      it('matches application/* to first application format', () => {
        const result = determineSyncFormat('application/*', supportedFormats)
        expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
      })

      it('matches text/* to first text format', () => {
        const result = determineSyncFormat('text/*', supportedFormats)
        expect(result).toEqual({ mode: 'sync', contentType: 'text/plain' })
      })

      it('prioritizes exact match over wildcard', () => {
        const result = determineSyncFormat('text/csv, application/*', supportedFormats)
        expect(result).toEqual({ mode: 'sync', contentType: 'text/csv' })
      })

      it('uses wildcard when exact match not found', () => {
        const result = determineSyncFormat('text/xml, application/*', supportedFormats)
        expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
      })

      it('prioritizes SSE over wildcard', () => {
        const result = determineSyncFormat('text/event-stream, text/*', supportedFormats)
        expect(result).toEqual({ mode: 'sse' })
      })

      it('respects quality values with wildcards', () => {
        const result = determineSyncFormat('text/*;q=0.5, application/*;q=0.9', supportedFormats)
        expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
      })

      it('falls back to default when wildcard type not in supported formats', () => {
        const result = determineSyncFormat('image/*', supportedFormats)
        expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
      })

      it('handles case-insensitive wildcard', () => {
        const result = determineSyncFormat('APPLICATION/*', supportedFormats)
        expect(result).toEqual({ mode: 'sync', contentType: 'application/json' })
      })

      it('matches first supported format in order for wildcard', () => {
        // Order matters: text/plain comes before text/csv in supportedFormats
        const result = determineSyncFormat('text/*', supportedFormats)
        expect(result).toEqual({ mode: 'sync', contentType: 'text/plain' })
      })
    })
  })

  describe('determineMode edge cases', () => {
    it('handles parameters without values', () => {
      // Parameters without '=' should be ignored
      const result = determineMode('application/json;charset')
      expect(result).toBe('json')
    })

    it('handles non-q parameters', () => {
      // Non-q parameters should be ignored
      const result = determineMode('application/json;charset=utf-8')
      expect(result).toBe('json')
    })

    it('handles multiple parameters including q', () => {
      // Multiple parameters, including q
      const result = determineMode('text/event-stream;charset=utf-8;q=0.5, application/json;q=0.9')
      expect(result).toBe('json')
    })
  })
})

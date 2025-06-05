import { isValidEmail, isValidUsername, isValidPassword } from '../../../src/utils/validators';

describe('Validators', () => {
  describe('isValidUsername', () => {
    it('should return true for valid usernames', () => {
      expect(isValidUsername('player1')).toBe(true);
      expect(isValidUsername('Player_123')).toBe(true);
      expect(isValidUsername('gamer999')).toBe(true);
    });

    it('should return false for invalid usernames', () => {
      expect(isValidUsername('')).toBe(false);
      expect(isValidUsername('ab')).toBe(false); // Too short
      expect(isValidUsername('player name')).toBe(false); // Contains space
      expect(isValidUsername('player@123')).toBe(false); // Contains special character
      expect(isValidUsername('a'.repeat(21))).toBe(false); // Too long
    });
  });

  describe('isValidEmail', () => {
    it('should return true for valid emails', () => {
      expect(isValidEmail('user@example.com')).toBe(true);
      expect(isValidEmail('test.user@domain.co.uk')).toBe(true);
      expect(isValidEmail('user123@gaming.net')).toBe(true);
    });

    it('should return false for invalid emails', () => {
      expect(isValidEmail('')).toBe(false);
      expect(isValidEmail('notanemail')).toBe(false);
      expect(isValidEmail('user@')).toBe(false);
      expect(isValidEmail('@domain.com')).toBe(false);
      expect(isValidEmail('user@domain')).toBe(false);
    });
  });

  describe('isValidPassword', () => {
    it('should return true for valid passwords', () => {
      expect(isValidPassword('Password123')).toBe(true);
      expect(isValidPassword('SecurePass1')).toBe(true);
      expect(isValidPassword('Abcd1234')).toBe(true);
    });

    it('should return false for invalid passwords', () => {
      expect(isValidPassword('')).toBe(false);
      expect(isValidPassword('short1A')).toBe(false); // Too short
      expect(isValidPassword('password123')).toBe(false); // No uppercase
      expect(isValidPassword('PASSWORD123')).toBe(false); // No lowercase
      expect(isValidPassword('Password')).toBe(false); // No number
    });
  });
});

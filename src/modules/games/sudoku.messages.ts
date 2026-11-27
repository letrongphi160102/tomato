export const SUDOKU_MESSAGES = Object.freeze({
  notFound: 'Không tìm thấy ván chơi yêu cầu.',
  validationFailed: 'Dữ liệu ván chơi không hợp lệ.',
  rateLimited: (retryAfterSeconds: number) =>
    `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${retryAfterSeconds} giây.`,
  alreadyFinished: 'Ván chơi này đã kết thúc trước đó.',
  tooManyMistakes: 'Ván chơi đã vượt quá số lỗi cho phép (tối đa 3 lỗi).',
  invalidBoardSolution: 'Bảng đáp án chưa chính xác hoặc chưa điền đầy đủ.',
  invalidElapsedTime: 'Thời gian hoàn thành không hợp lệ.',
  gameCompleted: 'Chúc mừng bạn đã hoàn thành ván Sudoku!',
});

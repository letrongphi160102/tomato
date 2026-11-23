'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Camera, CheckCircle2, ExternalLink, Loader2, Trash2 } from 'lucide-react';

import { AvatarCropModal } from '@/components/profile/avatar-crop-modal';
import { UserAvatar } from '@/components/profile/user-avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/auth-client';
import { BIO_MAX_LENGTH } from '@/modules/profile/handle';
import type { OwnProfileDto } from '@/modules/profile/profile.service';

export interface EditProfileFormProps {
  readonly initialProfile: OwnProfileDto;
}

const MAX_CLIENT_AVATAR_BYTES = 10 * 1024 * 1024;
const ALLOWED_CLIENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface ApiErrorShape {
  readonly error?: {
    readonly message?: string;
    readonly details?: readonly { readonly field?: string; readonly message: string }[];
  };
}

function formatVietnameseDate(isoDate: string): string {
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(isoDate));
  } catch {
    return isoDate;
  }
}

export function EditProfileForm({ initialProfile }: EditProfileFormProps) {
  const router = useRouter();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const [savedProfile, setSavedProfile] = React.useState<OwnProfileDto>(initialProfile);
  const [fullName, setFullName] = React.useState(initialProfile.fullName);
  const [handle, setHandle] = React.useState(initialProfile.handle);
  const [bio, setBio] = React.useState(initialProfile.bio);

  const [savingProfile, setSavingProfile] = React.useState(false);
  const [profileError, setProfileError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [profileSuccess, setProfileSuccess] = React.useState<string | null>(null);

  const [cropImageUrl, setCropImageUrl] = React.useState<string | null>(null);
  const [cropModalOpen, setCropModalOpen] = React.useState(false);
  const [uploadingAvatar, setUploadingAvatar] = React.useState(false);
  const [removingAvatar, setRemovingAvatar] = React.useState(false);
  const [avatarError, setAvatarError] = React.useState<string | null>(null);
  const [avatarSuccess, setAvatarSuccess] = React.useState<string | null>(null);

  const revokeCropUrl = React.useCallback((url: string | null) => {
    if (url) {
      URL.revokeObjectURL(url);
    }
  }, []);

  React.useEffect(() => {
    return () => {
      revokeCropUrl(cropImageUrl);
    };
  }, [cropImageUrl, revokeCropUrl]);

  const hasProfileChanges =
    fullName.trim() !== savedProfile.fullName ||
    handle.trim().replace(/^@/, '').toLowerCase() !== savedProfile.handle ||
    bio.replace(/\r\n?/g, '\n').trim() !== savedProfile.bio;

  function handleSelectAvatarFile(event: React.ChangeEvent<HTMLInputElement>) {
    setAvatarError(null);
    setAvatarSuccess(null);

    const file = event.target.files?.[0];
    // Reset input value để người dùng có thể chọn lại cùng 1 tệp nếu muốn.
    event.target.value = '';

    if (!file) {
      return;
    }

    if (
      file.size > MAX_CLIENT_AVATAR_BYTES ||
      (file.type && !ALLOWED_CLIENT_TYPES.has(file.type))
    ) {
      setAvatarError('Ảnh không hợp lệ hoặc vượt quá kích thước cho phép.');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setCropImageUrl((prev) => {
      revokeCropUrl(prev);
      return objectUrl;
    });
    setCropModalOpen(true);
  }

  function handleCloseCropModal() {
    if (uploadingAvatar) {
      return;
    }
    setCropModalOpen(false);
    setCropImageUrl((prev) => {
      revokeCropUrl(prev);
      return null;
    });
    setAvatarError(null);
  }

  async function handleConfirmCrop(croppedBlob: Blob) {
    setUploadingAvatar(true);
    setAvatarError(null);
    setAvatarSuccess(null);

    try {
      const formData = new FormData();
      formData.append('file', croppedBlob, 'avatar.jpg');

      const response = await authFetch('/api/v1/users/me/avatar', {
        method: 'POST',
        body: formData,
      });

      const payload = (await response.json().catch(() => null)) as
        { readonly avatarUrl?: string; readonly message?: string } | ApiErrorShape | null;

      if (!response.ok) {
        const message =
          (payload as ApiErrorShape | null)?.error?.message ??
          'Không thể cập nhật ảnh đại diện lúc này. Vui lòng thử lại.';
        setAvatarError(message);
        return;
      }

      const nextUrl =
        payload && 'avatarUrl' in payload && typeof payload.avatarUrl === 'string'
          ? payload.avatarUrl
          : null;
      const successMsg =
        payload && 'message' in payload && typeof payload.message === 'string'
          ? payload.message
          : 'Đã cập nhật ảnh đại diện thành công.';

      setSavedProfile((prev) => ({ ...prev, avatarUrl: nextUrl }));
      setAvatarSuccess(successMsg);
      setCropModalOpen(false);
      setCropImageUrl((prev) => {
        revokeCropUrl(prev);
        return null;
      });
      router.refresh();
    } catch {
      setAvatarError('Không thể kết nối máy chủ. Vui lòng thử lại.');
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function handleRemoveAvatar() {
    if (removingAvatar || !savedProfile.avatarUrl) {
      return;
    }
    setRemovingAvatar(true);
    setAvatarError(null);
    setAvatarSuccess(null);

    try {
      const response = await authFetch('/api/v1/users/me/avatar', {
        method: 'DELETE',
      });
      const payload = (await response.json().catch(() => null)) as
        { readonly message?: string } | ApiErrorShape | null;

      if (!response.ok) {
        const message =
          (payload as ApiErrorShape | null)?.error?.message ??
          'Không thể gỡ ảnh đại diện lúc này. Vui lòng thử lại.';
        setAvatarError(message);
        return;
      }

      setSavedProfile((prev) => ({ ...prev, avatarUrl: null }));
      setAvatarSuccess(
        payload && 'message' in payload && typeof payload.message === 'string'
          ? payload.message
          : 'Đã gỡ ảnh đại diện.',
      );
      router.refresh();
    } catch {
      setAvatarError('Không thể kết nối máy chủ. Vui lòng thử lại.');
    } finally {
      setRemovingAvatar(false);
    }
  }

  async function handleSaveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingProfile || !hasProfileChanges) {
      return;
    }

    setSavingProfile(true);
    setProfileError(null);
    setProfileSuccess(null);
    setFieldErrors({});

    const patchBody: Record<string, string> = {};
    if (fullName.trim() !== savedProfile.fullName) {
      patchBody.fullName = fullName;
    }
    const cleanedHandle = handle.trim().replace(/^@/, '').toLowerCase();
    if (cleanedHandle !== savedProfile.handle) {
      patchBody.handle = cleanedHandle;
    }
    if (bio.replace(/\r\n?/g, '\n').trim() !== savedProfile.bio) {
      patchBody.bio = bio;
    }

    try {
      const response = await authFetch('/api/v1/users/me/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patchBody),
      });

      const payload = (await response.json().catch(() => null)) as
        { readonly profile?: OwnProfileDto; readonly message?: string } | ApiErrorShape | null;

      if (!response.ok) {
        const err = (payload as ApiErrorShape | null)?.error;
        const nextFieldErrors: Record<string, string> = {};
        for (const detail of err?.details ?? []) {
          if (detail.field && !nextFieldErrors[detail.field]) {
            nextFieldErrors[detail.field] = detail.message;
          }
        }
        setFieldErrors(nextFieldErrors);
        setProfileError(err?.message ?? 'Không thể lưu thay đổi lúc này. Vui lòng thử lại.');
        return;
      }

      if (payload && 'profile' in payload && payload.profile) {
        setSavedProfile(payload.profile);
        setFullName(payload.profile.fullName);
        setHandle(payload.profile.handle);
        setBio(payload.profile.bio);
      }
      setProfileSuccess(
        payload && 'message' in payload && typeof payload.message === 'string'
          ? payload.message
          : 'Đã lưu thay đổi hồ sơ của bạn.',
      );
      router.refresh();
    } catch {
      setProfileError('Không thể kết nối máy chủ. Vui lòng thử lại.');
    } finally {
      setSavingProfile(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="shadow-sm">
        <CardHeader className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg">Ảnh đại diện</CardTitle>
            <CardDescription>
              Ảnh đại diện hiển thị trên trang cá nhân, thanh điều hướng và kết quả tìm kiếm.
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm" className="w-fit shrink-0">
            <Link href={`/u/${encodeURIComponent(savedProfile.handle)}`}>
              <span>Xem trang cá nhân</span>
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </CardHeader>

        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
            <UserAvatar
              fullName={savedProfile.fullName}
              avatarUrl={savedProfile.avatarUrl}
              size="xl"
            />

            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <input
                  ref={fileInputRef}
                  id="profile-avatar-file"
                  name="avatarFile"
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                  onChange={handleSelectAvatarFile}
                  className="sr-only"
                  aria-label="Chọn tệp ảnh đại diện"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={uploadingAvatar || removingAvatar}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Camera className="size-4" aria-hidden="true" />
                  <span>Đổi ảnh đại diện</span>
                </Button>

                {savedProfile.avatarUrl ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadingAvatar || removingAvatar}
                    onClick={() => void handleRemoveAvatar()}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    {removingAvatar ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="size-4" aria-hidden="true" />
                    )}
                    <span>Gỡ ảnh đại diện</span>
                  </Button>
                ) : null}
              </div>

              <p className="text-xs text-muted-foreground">
                Hỗ trợ ảnh JPG, PNG, WebP dung lượng tối đa 10 MB.
              </p>
            </div>
          </div>

          {avatarError && !cropModalOpen ? (
            <Alert variant="destructive">
              <AlertDescription>{avatarError}</AlertDescription>
            </Alert>
          ) : null}

          {avatarSuccess ? (
            <div
              role="status"
              className="flex items-center gap-2 rounded-lg border border-emerald-600/30 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800"
            >
              <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
              <span>{avatarSuccess}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="border-b pb-4">
          <CardTitle className="text-lg">Chỉnh sửa hồ sơ</CardTitle>
          <CardDescription>
            Cập nhật tên hiển thị, ID tài khoản và tiểu sử hiển thị công khai trên Tomato.
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-6">
          <form
            onSubmit={(event) => void handleSaveProfile(event)}
            className="space-y-5"
            noValidate
          >
            {profileError ? (
              <Alert variant="destructive">
                <AlertDescription>{profileError}</AlertDescription>
              </Alert>
            ) : null}

            {profileSuccess ? (
              <div
                role="status"
                className="flex items-center gap-2 rounded-lg border border-emerald-600/30 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800"
              >
                <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                <span>{profileSuccess}</span>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="profile-full-name">Tên hiển thị</Label>
              <Input
                id="profile-full-name"
                name="fullName"
                value={fullName}
                maxLength={50}
                autoComplete="name"
                disabled={savingProfile}
                onChange={(event) => {
                  setFullName(event.target.value);
                  setProfileSuccess(null);
                }}
              />
              {fieldErrors.fullName ? (
                <p className="text-xs font-medium text-destructive">{fieldErrors.fullName}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="profile-handle">ID tài khoản</Label>
              <div className="relative flex items-center">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 text-sm font-medium text-muted-foreground"
                >
                  @
                </span>
                <Input
                  id="profile-handle"
                  name="handle"
                  value={handle}
                  maxLength={30}
                  autoComplete="username"
                  disabled={savingProfile}
                  onChange={(event) => {
                    setHandle(event.target.value.replace(/^@+/, ''));
                    setProfileSuccess(null);
                  }}
                  className="pl-7"
                />
              </div>
              {fieldErrors.handle ? (
                <p className="text-xs font-medium text-destructive">{fieldErrors.handle}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {savedProfile.handleChangesRemaining > 0
                  ? `Chỉ dùng chữ thường không dấu, số, dấu chấm (.) và gạch dưới (_). Bạn còn ${savedProfile.handleChangesRemaining} lượt đổi trong 14 ngày.`
                  : savedProfile.nextHandleChangeAvailableAt
                    ? `Bạn đã dùng hết lượt đổi ID trong 14 ngày qua. Bạn có thể đổi lại sau ngày ${formatVietnameseDate(savedProfile.nextHandleChangeAvailableAt)}.`
                    : 'Bạn đã dùng hết lượt đổi ID trong 14 ngày qua.'}
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="profile-bio">Tiểu sử</Label>
                <span className="text-xs text-muted-foreground">
                  {bio.length} / {BIO_MAX_LENGTH}
                </span>
              </div>
              <textarea
                id="profile-bio"
                name="bio"
                rows={4}
                maxLength={BIO_MAX_LENGTH}
                disabled={savingProfile}
                placeholder="Viết vài dòng giới thiệu ngắn về bạn..."
                value={bio}
                onChange={(event) => {
                  setBio(event.target.value);
                  setProfileSuccess(null);
                }}
                className="flex min-h-[96px] w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
              {fieldErrors.bio ? (
                <p className="text-xs font-medium text-destructive">{fieldErrors.bio}</p>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <Button
                type="submit"
                disabled={savingProfile || !hasProfileChanges}
                className="min-w-[136px]"
              >
                {savingProfile ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    <span>Đang lưu...</span>
                  </>
                ) : (
                  <span>Lưu thay đổi</span>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <AvatarCropModal
        open={cropModalOpen}
        imageSrc={cropImageUrl}
        saving={uploadingAvatar}
        errorMessage={avatarError}
        onClose={handleCloseCropModal}
        onConfirm={handleConfirmCrop}
      />
    </div>
  );
}
